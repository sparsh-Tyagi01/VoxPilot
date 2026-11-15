import type { SiteAction, SiteDecision, SiteDecisionRequest, SiteObservation, SiteStepResult, SiteTaskState } from "@shared/site-task.js";
import { SITE_TERMINAL } from "@shared/site-task.js";
import { checkSitePolicy, siteChanged, visibleSiteText } from "./site-policy.js";

interface Dependencies {
  observe(tabId: number, after?: SiteObservation): Promise<SiteObservation>;
  decide(request: SiteDecisionRequest): Promise<SiteDecision>;
  execute(tabId: number, action: SiteAction, observation: SiteObservation, fingerprint: string): Promise<SiteStepResult>;
  current(tabId: number, origin: string, documentId?: string): Promise<boolean>;
  publish(state: SiteTaskState): Promise<void>;
  receipt(taskId: string, index: number, action: SiteAction, state: "dispatched" | "acknowledged" | "uncertain"): Promise<void>;
}
export class SiteTaskRunner {
  private state: SiteTaskState | null = null;
  private controller: AbortController | null = null;
  private response: ((answer: string) => void) | null = null;
  private approval: ((approved: boolean) => void) | null = null;
  constructor(private readonly deps: Dependencies) {}
  get active(): boolean { return Boolean(this.state && !SITE_TERMINAL.has(this.state.status)); }
  async start(goal: string, tabId: number, origin: string): Promise<void> {
    if (this.active) throw new Error("Finish or stop the current task before starting another.");
    if (typeof goal !== "string" || !goal.trim() || goal.length > 500) throw new Error("Describe the task in 500 characters or fewer.");
    this.controller = new AbortController();
    this.state = { version: 1, id: crypto.randomUUID(), goal: goal.trim(), tabId, origin, status: "observing", steps: 0, message: "Inspecting the current page…" };
    await this.deps.publish({ ...this.state });
    void this.run(this.state, this.controller.signal).catch(() => { if (this.state) this.state.status = "limited"; });
  }
  cancel(): void { this.controller?.abort(); this.response?.(""); this.approval?.(false); }
  reply(taskId: string, answer: string): boolean {
    if (this.state?.id !== taskId || this.state.status !== "awaiting_answer" || typeof answer !== "string" || !answer.trim() || answer.length > 500 || !this.response) return false;
    const respond = this.response; this.response = null; respond(answer.trim()); return true;
  }
  approve(taskId: string, approvalId: string, approved: boolean): boolean {
    if (this.state?.id !== taskId || this.state.status !== "awaiting_approval" || this.state.approval?.id !== approvalId || Date.now() >= this.state.approval.expiresAt || !this.approval) return false;
    const accept = this.approval; this.approval = null; accept(approved); return true;
  }
  private async run(task: SiteTaskState, signal: AbortSignal): Promise<void> {
    const started = Date.now(); let userWait = 0; let calls = 0; let discovery = 0; let stagnant = 0;
    const history: SiteDecisionRequest["history"] = []; const answers: string[] = [];
    let initialText = ""; let mutationUnverified = false; let lastWasFieldEdit = false;
    let boundDocument: string | undefined;
    const publish = async (status: SiteTaskState["status"], message: string) => {
      task.status = status; task.message = message;
      if (status !== "awaiting_answer") delete task.question;
      if (status !== "awaiting_approval") delete task.approval;
      await this.deps.publish({ ...task });
    };
    const check = async () => {
      if (signal.aborted) throw new DOMException("Task stopped.", "AbortError");
      if (Date.now() - started - userWait >= 120_000) throw new Error("The task reached its time budget. Check the page before continuing.");
      if (!await this.deps.current(task.tabId, task.origin, boundDocument)) throw new Error("The selected tab, document or site changed. Start a new request on the current page.");
      if (signal.aborted) throw new DOMException("Task stopped.", "AbortError");
    };
    const bounded = <T>(promise: Promise<T>, ms: number): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(new DOMException("Task stopped.", "AbortError")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("The site task stopped responding. Check the page before continuing.")); }, Math.max(1, ms));
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
    try {
      await check();
      let observation = await bounded(this.deps.observe(task.tabId), 10_000);
      boundDocument = observation.documentId;
      initialText = visibleSiteText(observation);
      while (calls < 16 && task.steps < 12) {
        await check();
        await publish("planning", "Choosing the next step from the current page…");
        const remainingMs = 120_000 - (Date.now() - started - userWait);
        const decision = await bounded(this.deps.decide({ taskId: task.id, goal: task.goal, observation, history: history.slice(-8), answers: answers.slice(-4), remainingMs }), remainingMs);
        calls++; await check();
        if (decision.kind === "ask") {
          if (/password|cvv|card number|one.time.code|verification code/i.test(decision.question)) throw new Error("Complete authentication and payment details directly on the site; do not dictate secrets to the agent.");
          if (answers.length >= 4) throw new Error("More information is still needed. Please start a more specific request.");
          task.question = decision.question;
          const waitStarted = Date.now();
          const answer = new Promise<string>(resolve => { this.response = resolve; });
          await publish("awaiting_answer", decision.question);
          try { answers.push(await bounded(answer, 180_000)); } finally { this.response = null; userWait += Date.now() - waitStarted; }
          await check();
          const refreshed = await bounded(this.deps.observe(task.tabId), 10_000);
          if (refreshed.documentId !== observation.documentId) throw new Error("The page navigated while waiting for your answer. Start a fresh request on this page.");
          observation = refreshed; continue;
        }
        if (decision.kind === "unavailable") {
          await publish("limited", `${decision.reason === "not_found_in_scope" ? "On the inspected page: " : ""}${decision.message}`); return;
        }
        if (decision.kind === "finish" || decision.kind === "answer") {
          const text = visibleSiteText(observation);
          const grounded = decision.evidence.every(quote => quote.trim().length >= 8 && text.includes(quote.replace(/\s+/g, " ").trim()));
          const newEvidence = decision.evidence.some(quote => !initialText.includes(quote.replace(/\s+/g, " ").trim()));
          if (!grounded || (task.steps > 0 && (mutationUnverified || lastWasFieldEdit || !newEvidence)) || (decision.kind === "finish" && task.steps === 0)) {
            history.push({ action: "completion_rejected", outcome: "No sufficient new evidence of the requested outcome. Observe further or explain the limitation; field entry is not search submission." });
            if (++stagnant >= 2) { await publish("limited", "I could not verify the requested outcome. Check the page before trying again."); return; }
            continue;
          }
          await publish(decision.kind === "answer" ? "answered" : "completed", decision.message); return;
        }
        if (decision.kind === "observe") {
          if (++discovery > 3) throw new Error("I could not find a usable action within the inspected page. Try a more specific request or continue manually.");
          await publish("observing", "Checking the page for more information…");
          const next = await bounded(this.deps.observe(task.tabId), 10_000);
          if (next.documentId !== observation.documentId) throw new Error("The page navigated outside the task. Start a fresh request.");
          stagnant = siteChanged(observation, next) ? 0 : stagnant + 1;
          observation = next;
          if (stagnant >= 2) throw new Error("No new usable controls were found in the inspected page. A menu, login or unsupported widget may be involved.");
          continue;
        }
        const policy = checkSitePolicy(decision.action, observation, task.origin);
        if (!policy.allowed) { await publish("limited", policy.reason); return; }
        if (policy.approval) {
          task.approval = { id: crypto.randomUUID(), description: policy.description, context: policy.context, destination: policy.destination, expiresAt: Date.now() + 180_000 };
          const waitStarted = Date.now();
          const approved = new Promise<boolean>(resolve => { this.approval = resolve; });
          await publish("awaiting_approval", "Review this action in the extension popup before continuing.");
          let accepted: boolean;
          try { accepted = await bounded(approved, 180_000); } finally { this.approval = null; userWait += Date.now() - waitStarted; }
          if (!accepted) { await publish("cancelled", "Task cancelled. Earlier page changes may remain."); return; }
          await check();
        }
        await publish("executing", policy.description);
        await this.deps.receipt(task.id, task.steps, decision.action, "dispatched");
        await check();
        let result: SiteStepResult;
        try {
          result = await bounded(this.deps.execute(task.tabId, decision.action, observation, policy.fingerprint), 12_000);
          await this.deps.receipt(task.id, task.steps, decision.action, "acknowledged");
        } catch {
          await this.deps.receipt(task.id, task.steps, decision.action, "uncertain");
          await publish(signal.aborted ? "cancelled" : "unknown", "The action may have applied, but I could not confirm its result. Check the page before repeating it."); return;
        }
        task.steps++;
        if (result.navigationExpected) boundDocument = undefined;
        await publish("verifying", "Checking what changed…");
        await check();
        const next = await bounded(this.deps.observe(task.tabId, result.controlVerified ? undefined : observation), 10_000);
        if (next.documentId !== observation.documentId && !result.navigationExpected) { await publish("unknown", "The page navigated unexpectedly. Check it before starting another request."); return; }
        const changed = siteChanged(observation, next);
        const expected = decision.expected;
        const verified = expected.kind === "control_state" ? result.controlVerified
          : expected.kind === "text_appeared" ? expected.text.trim().length >= 8 && !visibleSiteText(observation).includes(expected.text) && visibleSiteText(next).includes(expected.text)
            : changed;
        lastWasFieldEdit = ["type", "select", "toggle"].includes(decision.action.type);
        mutationUnverified = !verified;
        history.push({ action: policy.description, outcome: verified ? `Observed ${expected.kind}.` : "Effect not verified. Do not repeat this mutation; observe or explain the uncertainty." });
        if (!verified && !["scroll", "read"].includes(decision.action.type)) { await publish("unknown", "The control was activated, but the expected result was not observed. Check the page before repeating the action."); return; }
        stagnant = changed || result.controlVerified ? 0 : stagnant + 1;
        observation = next;
        boundDocument = next.documentId;
      }
      await publish("limited", "The task reached its step budget. Check the current page, then ask to continue if needed.");
    } catch (error) {
      await publish(signal.aborted ? "cancelled" : "limited", signal.aborted ? "Task stopped. Earlier page changes may remain." : error instanceof Error ? error.message : "The task could not continue.");
    } finally { if (this.state === task) { this.response = null; this.approval = null; } }
  }
}
