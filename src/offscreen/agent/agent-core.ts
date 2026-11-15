/**
 * @file src/offscreen/agent/agent-core.ts
 * @description Agent state machine — the central coordinator of the VoxPilot agent.
 *
 * State transitions:
 *
 *   Idle ──► Listening ──► Transcribing ──► Routing ──► Planning ──► Confirming ──► Executing ──► Speaking ──► Listening
 *                                                   └───────────────────────────────────────────────────────────────────► Error
 *
 * The AgentCore:
 * 1. Owns the STT and LLM Web Workers and their lifecycle
 * 2. Receives speech audio from VAD callbacks → sends to STT worker
 * 3. Routes transcripts to IntentRouter (fast-path) or Planner (LLM)
 * 4. Validates the resulting AgentPlan via PlanValidator
 * 5. Requests confirmation for high-risk plans (R3/R4)
 * 6. Dispatches the plan to the content script via SW
 * 7. Speaks the result via TTS
 * 8. Handles the global kill switch ("stop" command, FR-SAFE-04)
 * 9. Streams LLM tokens to panel for live display
 *
 * SRS references:
 * - FR-VOICE-01: Voice command lifecycle
 * - FR-SAFE-04: Kill switch — stop → Listening ≤200ms
 * - NFR-REL-01: R3/R4 plans ALWAYS require confirmation
 * - NFR-PERF-01: Latency budgets
 */

import { AgentState, RiskTier, ModelProfile } from "@shared/types.js";
import type { AgentPlan, PageSnapshot } from "@shared/types.js";
import {
  RISK_TIER_CONFIG,
  STT_TIMEOUT_MS,
  DEFAULT_MODEL_PROFILE,
  MODEL_PROFILE_CONFIG,
} from "@shared/constants.js";
import { TTS } from "../audio/tts.js";
import { IntentRouter } from "./intent-router.js";
import { Planner, type PlannerLLMInterface } from "./planner.js";
import { GPU_RECOVERY_MODEL, GPU_RECOVERY_DELAY_MS, GPU_RECOVERY_LOAD_TIMEOUT_MS, isGPUDeviceLoss } from "../llm/gpu-errors.js";
import type { ChatMessage } from "../llm/llm-worker.js";
import { PlanValidator } from "./plan-validator.js";
import { RiskClassifier } from "./risk-classifier.js";
import { UndoStack } from "./undo-stack.js";
import { sendToSW } from "../offscreen.js";
import { decideSiteStep } from "./site-planner.js";
import { SITE_TERMINAL } from "@shared/site-task.js";
import type { SiteDecisionRequest, SiteTaskState, SiteDecision } from "@shared/site-task.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Configuration for AgentCore. */
export interface AgentCoreConfig {
  tts: TTS;
  /** Migration switch for integration qualification; the shipped runtime defaults on. */
  siteAware?: boolean;
}

/** STT worker message types (inbound). */
type STTMessage =
  | { type: "ready" }
  | { type: "result"; text: string; confidence: number | null; language: string }
  | { type: "error"; message: string; stack?: string }
  | { type: "progress"; loaded: number; total: number; modelId: string; downloading?: boolean };

/** LLM worker message types (inbound). */
type LLMMessage =
  | { type: "ready" }
  | { type: "cancelled"; requestId: string }
  | { type: "progress"; loaded: number; total: number; text: string; downloading?: boolean }
  | { type: "token"; requestId: string; delta: string }
  | { type: "result"; requestId: string; text: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { type: "error"; requestId: string; message: string; code?: "GPU_DEVICE_LOST"; stack?: string };

// ─── AgentCore ─────────────────────────────────────────────────────────────────

/**
 * AgentCore coordinates the full voice → action pipeline.
 * It owns the STT and LLM workers and manages the agent state machine.
 */
export class AgentCore {
  private siteTask: SiteTaskState | null = null;
  private readonly siteAware: boolean;
  private state: AgentState = AgentState.Idle;
  private readonly tts: TTS;
  private readonly intentRouter: IntentRouter;
  private readonly planner: Planner;
  private readonly validator: PlanValidator;
  private readonly riskClassifier: RiskClassifier;
  private readonly undoStack: UndoStack;

  // ─── Workers ───────────────────────────────────────────────────────────────

  private sttWorker: Worker | null = null;
  private llmWorker: Worker | null = null;

  // ─── Worker readiness promises ─────────────────────────────────────────────

  /** Resolves when the STT worker signals 'ready'. */
  private sttReady!: Promise<void>;
  private sttReadyResolve!: () => void;
  private sttReadyReject!: (err: Error) => void;

  /** Resolves when the LLM worker signals 'ready'. */
  private llmReady!: Promise<void>;
  private llmReadyResolve!: () => void;
  private llmReadyReject!: (err: Error) => void;

  // ─── Pending STT call ──────────────────────────────────────────────────────

  private sttResolve: ((result: { text: string; confidence: number | null; language: string }) => void) | null = null;
  private sttReject: ((err: Error) => void) | null = null;

  // ─── LLM result/token callbacks keyed by requestId ────────────────────────

  private llmResultCallbacks = new Map<string, (text: string) => void>();
  private llmErrorCallbacks = new Map<string, (message: string) => void>();
  private llmTokenCallbacks = new Map<string, (delta: string) => void>();

  // ─── Page snapshot ─────────────────────────────────────────────────────────

  private currentSnapshot: PageSnapshot | null = null;
  private snapshotResolve: (() => void) | null = null;

  // ─── Ask-action answer ──────────────────────────────────────────────────────

  private answerResolve: ((answer: string) => void) | null = null;

  // ─── Kill switch ──────────────────────────────────────────────────────────

  /** Set to true when "stop" / kill switch is triggered mid-operation. */
  private killRequested = false;
  private operationId = 0;
  private lifecycleId = 0;
  private initializedProfile: ModelProfile | null = null;
  private initializationFailed = false;
  private listeningEnabled = false;
  private speechPending = false;
  private speechSequence = 0;
  private speechStarted = false;
  private speechBargeIn = false;
  private commandBusy = false;
  private sttModelId = "";
  private llmModelId = "";
  private llmIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private llmRequested = false;
  private llmRecoveryAttempts = 0;
  private llmCircuitOpen = false;
  private llmRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private llmAbortTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── Model loading state tracking ──────────────────────────────────────────
  private sttProgress = 0;
  private llmProgress = 0;
  private sttDownloading = false;
  private llmDownloading = false;
  private loadId = "";
  private isSttReady = false;
  private isLlmReady = false;

  constructor(config: AgentCoreConfig) {
    this.siteAware = config.siteAware !== false;
    this.tts = config.tts;
    this.intentRouter = new IntentRouter();
    this.planner = new Planner();
    this.validator = new PlanValidator();
    this.riskClassifier = new RiskClassifier();
    this.undoStack = new UndoStack();

    this.resetReadinessPromises();
  }

  // ─── Initialization ────────────────────────────────────────────────────────

  /**
   * Spawn STT and LLM workers, load models, and wire up the Planner.
   * Called once when the offscreen document starts or during profile change.
   */
  async initialize(profile: ModelProfile = DEFAULT_MODEL_PROFILE, preloadPlanner = false): Promise<void> {
    if (this.initializedProfile === profile && this.llmCircuitOpen && this.sttWorker) {
      this.emitModelError("GPU planning is unavailable. Basic commands still work. Retry model setup explicitly after restarting Chrome or freeing GPU resources.");
      return;
    }
    if (this.initializedProfile === profile && this.sttWorker && (!this.initializationFailed || Boolean(this.llmRecoveryTimer))) {
      this.emitModelProgress();
      return;
    }
    if (this.sttWorker || this.llmWorker) this.dispose();
    this.lifecycleId++;
    this.initializedProfile = profile;
    this.llmRequested = preloadPlanner && profile !== ModelProfile.Essential;
    this.llmRecoveryAttempts = 0;
    this.llmCircuitOpen = false;
    this.initializationFailed = false;
    this.loadId = `${profile}-${Date.now()}-${this.lifecycleId}`;
    this.sttDownloading = false;
    this.llmDownloading = false;
    this.resetReadinessPromises();
    this.isSttReady = false;
    this.isLlmReady = false;
    this.sttProgress = 0;
    this.llmProgress = 0;
    const initializationId = this.lifecycleId;
    console.log(`[AgentCore] Initializing workers with profile "${profile}"…`);

    const profileConfig = MODEL_PROFILE_CONFIG[profile] ?? MODEL_PROFILE_CONFIG[DEFAULT_MODEL_PROFILE];
    this.sttModelId = profileConfig.sttModelId;
    this.spawnSTTWorker();

    this.llmModelId = profileConfig.modelId;
    if (preloadPlanner && profile !== ModelProfile.Essential) this.spawnLLMWorker();

    // ── Wire Planner to LLM worker ──────────────────────────────────────────
    const llmInterface = this.buildPlannerLLMInterface();
    this.planner.setLLMInterface(llmInterface);

    // ── Determine model IDs for current profile ─────────────────────────────
    // Post load requests
    this.sttModelId = profileConfig.sttModelId;
    this.sttWorker!.postMessage({ type: "load", modelId: profileConfig.sttModelId });
    this.llmWorker?.postMessage({ type: "load", modelId: profileConfig.modelId });

    // Emit initial progress
    this.emitModelProgress("Opening saved models…");

    // Transition to Listening as soon as STT worker is ready (Whisper loaded).
    this.sttReady
      .then(async () => {
        if (initializationId !== this.lifecycleId) return;
        console.log("[AgentCore] STT ready — transitioning to Listening.");
        if (this.listeningEnabled && this.state === AgentState.Idle) {
          this.transitionTo(AgentState.Listening);
          await sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Listening });
        }
      })
      .catch((err: unknown) => {
        if (initializationId !== this.lifecycleId) return;
        this.handlePipelineError(new Error(`Speech model could not open: ${err instanceof Error ? err.message : String(err)}. Retry setup or check model storage.`));
      });

    // LLM loads in background for complex multi-step planning
    this.llmReady
      .then(() => {
        if (initializationId !== this.lifecycleId) return;
        console.log("[AgentCore] LLM worker ready for complex planning.");
      })
      .catch((err: unknown) => {
        if (initializationId !== this.lifecycleId) return;
        console.warn("[AgentCore] LLM worker unavailable (fast-path commands still functional):", err);
      });

    console.log("[AgentCore] Workers spawned — model loading in progress.");
  }

  // ─── VAD Callbacks ─────────────────────────────────────────────────────────

  /**
   * Called by VAD when speech starts.
   * Transitions to Transcribing state. Implements barge-in (SRS FR-VOICE-03).
   */
  onSpeechStart(): void {
    if (!this.listeningEnabled || this.speechPending || this.speechStarted || !this.isSttReady) return;
    this.speechStarted = true;
    this.speechBargeIn = this.commandBusy || ![AgentState.Listening, AgentState.Idle].includes(this.state);
    if (!this.speechBargeIn) this.transitionTo(AgentState.Transcribing);
    if (this.tts.isSpeaking) this.tts.stop();
  }

  /**
   * Called by VAD when speech ends with the full utterance audio.
   * Runs the full voice → plan → execute pipeline.
   */
  async onSpeechEnd(audio: Float32Array): Promise<void> {
    if (!this.speechStarted || this.speechPending || !this.listeningEnabled) return;
    this.speechStarted = false;
    this.speechPending = true;
    const speechSequence = ++this.speechSequence;
    const bargeIn = this.speechBargeIn;
    const operationId = this.operationId;

    try {
      // Await STT worker readiness if model is still downloading
      await this.sttReady;

      if (operationId !== this.operationId) return;

      // ── Step 1: Transcribe ───────────────────────────────────────────────
      const transcript = await this.measure("recognition", () => this.transcribe(audio));
      if (operationId !== this.operationId) return;
      if (bargeIn && this.siteTask?.status !== "awaiting_answer") {
        if (this.intentRouter.isKillCommand(transcript.text)) this.triggerKill();
        return;
      }
      if (!transcript.text.trim()) {
        this.transitionTo(this.listeningEnabled ? AgentState.Listening : AgentState.Idle);
        await sendToSW({ type: "AGENT_STATE_CHANGED", state: this.state });
        return;
      }


      await sendToSW({
        type: "TRANSCRIPT",
        text: transcript.text,
        confidence: transcript.confidence,
        language: transcript.language,
        isFinal: true,
      });

      // Release capture before planning so voice stop can interrupt this plan.
      this.speechPending = false;
      if (operationId === this.operationId) await this.processUtterance(transcript.text);
    } catch (err: unknown) {
      if (operationId === this.operationId) this.handlePipelineError(err);
    } finally {
      // A newer barge-in may already own the recognition gate.
      if (speechSequence === this.speechSequence) this.speechPending = false;
    }
  }

  /**
   * Execute a natural language text command directly (e.g. from Web Speech API fast-path).
   */
  async executeCommandText(text: string): Promise<void> {
    await this.processUtterance(text, "text");
  }

  /**
   * Core pipeline: takes transcribed text, checks safety/kill/undo,
   * performs intent routing / LLM planning, validates plan, and sends to SW.
   */
  private async processUtterance(text: string, source: "voice" | "text" = "voice"): Promise<void> {
    if (this.intentRouter.isKillCommand(text)) { this.triggerKill(); return; }
    if (this.siteTask && !SITE_TERMINAL.has(this.siteTask.status)) {
      if (this.siteTask.status === "awaiting_answer" && text.trim()) await sendToSW({ type: "SITE_TASK_REPLY", taskId: this.siteTask.id, answer: text.trim() });
      else if (source === "text") await sendToSW({ type: "COMMAND_NOTICE", text: "Finish or stop the current task before starting another." });
      return;
    }
    if (!text.trim() || this.commandBusy || this.sttResolve || this.state === AgentState.Confirming || this.state === AgentState.Executing) return;
    this.commandBusy = true;
    this.currentSnapshot = null;
    const operationId = ++this.operationId;
    try {
      this.transitionTo(AgentState.Routing);

      // ── Step 2: Kill switch check ────────────────────────────────────────
      if (this.intentRouter.isKillCommand(text)) {
        this.handleKill();
        return;
      }

      // ── Step 2b: Undo check ──────────────────────────────────────────────
      if (this.intentRouter.isUndoCommand(text)) {
        await this.undo();
        this.transitionTo(AgentState.Listening);
        await sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Listening });
        return;
      }

      // ── Step 3: Intent Routing ────────────────────────────────────────────
      const routed = this.intentRouter.route(text);
      // A search is a workflow, not a typing shortcut with an optimistic summary.
      const fastPlan = routed?.actions.some(action => action.type === "type" && action.handle === "search") ? null : routed;

      let plan: AgentPlan;
      let snapshot: PageSnapshot | null = null;

      if (fastPlan) {
        console.log("[AgentCore] Fast-path intent matched — skipping LLM.");
        const needsSnapshot = fastPlan.actions.some(action => "handle" in action && action.handle);
        if (needsSnapshot) {
          this.currentSnapshot = null;
          await sendToSW({ type: "REQUEST_SNAPSHOT", includeText: false, tabId: await this.getActiveTabId() });
          snapshot = await this.waitForSnapshot();
          if (operationId !== this.operationId) return;
          plan = this.groundFastPlan(fastPlan, snapshot);
        } else plan = fastPlan;
      } else if (this.initializedProfile === ModelProfile.Essential) {
        // Unrecognized ambient audio is never an invitation to speak a tutorial.
        this.transitionTo(this.listeningEnabled ? AgentState.Listening : AgentState.Idle);
        await sendToSW({ type: "AGENT_STATE_CHANGED", state: this.state });
        if (source === "text") await sendToSW({ type: "COMMAND_NOTICE", text: "Command not recognized. Use a direct command or choose Assist in Settings." });
        return;
      } else if (this.siteAware) {
        this.transitionTo(AgentState.Planning);
        await sendToSW({ type: "START_SITE_TASK", goal: text });
        return;
      } else {
        // ── Step 4: Autonomous Planning ─────────────────────────────────────
        this.transitionTo(AgentState.Planning);
        await sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Planning });

        // Request a fresh page snapshot
        this.currentSnapshot = null;
        const tabId = await this.getActiveTabId();
        await sendToSW({ type: "REQUEST_SNAPSHOT", tabId });
        snapshot = await this.waitForSnapshot();

        if (operationId !== this.operationId) return;

        await this.ensurePlannerReady();
        if (operationId !== this.operationId) return;
        // Plan with Planner (real neural model only)
        plan = await this.measure("planning", () => this.planner.plan(text, snapshot!));
      }

      if (operationId !== this.operationId) return;

      // ── Step 5: Classify Risk & Validate ─────────────────────────────────
      this.validator.validate(plan);
      const risk = this.riskClassifier.classify(plan, snapshot?.url);

      const riskConfig = RISK_TIER_CONFIG[risk];

      // ═══ SAFETY INVARIANT (NFR-REL-01) ═══════════════════════════════════
      // R3/R4 plans MUST ALWAYS require explicit user confirmation.
      const needsConfirm = risk >= RiskTier.R3
        ? true  // ← Hardcoded safety floor.
        : (typeof plan.requiresConfirmation === "boolean" ? plan.requiresConfirmation : riskConfig.requiresConfirmation);

      plan = { ...plan, risk, requiresConfirmation: needsConfirm };

      // Strictly validate normalized plan with PlanValidator
      this.validator.validate(plan);

      // Set state before dispatch: the SW may synchronously finish execution.
      this.transitionTo(needsConfirm ? AgentState.Confirming : AgentState.Executing);
      await sendToSW({ type: "AGENT_STATE_CHANGED", state: this.state });
      await sendToSW({ type: "PLAN_PRODUCED", plan, ...(snapshot?.documentId ? { documentId: snapshot.documentId } : {}) });

      if (needsConfirm) {
        // Await explicit confirmation from the SW.
      } else {


        // Safety watchdog: auto-return to Listening if SW or execution stalls
        setTimeout(() => {
          if (operationId === this.operationId && this.state === AgentState.Executing) {
            console.warn("[AgentCore] Execution watchdog timed out — recovering to Listening state");
            this.onExecutionDone();
          }
        }, 12_000);
      }

    } catch (err: unknown) {
      if (operationId === this.operationId) this.handlePipelineError(err);
    } finally {
      if (operationId === this.operationId) this.commandBusy = false;
    }
  }

  private handlePipelineError(err: unknown): void {
    const operationId = this.operationId;
    const message = err instanceof Error ? err.message : String(err);
    console.error("[AgentCore] Pipeline error:", err);

    const _stack = err instanceof Error ? err.stack : undefined;
    void sendToSW({
      type: "OFFSCREEN_ERROR",
      source: "agent",
      message,
      ...(_stack !== undefined ? { stack: _stack } : {}),
    });

    this.transitionTo(AgentState.Error);
    void sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Error });

    // Auto-recover to Listening after 3 seconds
    setTimeout(() => {
      if (operationId === this.operationId && this.state === AgentState.Error) {
        this.transitionTo(this.listeningEnabled ? AgentState.Listening : AgentState.Idle);
        void sendToSW({ type: "AGENT_STATE_CHANGED", state: this.state });
      }
    }, 3_000);
  }

  // ─── External Event Handlers ───────────────────────────────────────────────

  /**
   * Execute a confirmed/auto-approved plan.
   * Called by offscreen.ts when SW relays EXECUTE_PLAN.
   */
  async executePlan(plan: AgentPlan, _tabId: number): Promise<void> {
    if (this.killRequested) { this.handleKill(); return; }
    console.log("[AgentCore] Executing plan:", plan.intent);
    this.transitionTo(AgentState.Executing);

    // Push to undo stack for reversible actions (R0–R2)
    if (plan.risk <= RiskTier.R2) {
      this.undoStack.push(plan, _tabId);
    }

    // Speak the done action summary
    this.transitionTo(AgentState.Speaking);
    try {
      const doneAction = plan.actions.find(a => a.type === "done") as { type: "done"; summary: string } | undefined;
      await this.tts.speak(doneAction?.summary ?? plan.intent);
    } finally {
      await sendToSW({ type: "TTS_DONE" });
      this.transitionTo(AgentState.Listening);
      await sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Listening });
    }
  }

  /**
   * Called when execution of a plan completes.
   * Returns the agent to the Listening state and cleans up the active snapshot.
   */
  onExecutionStarted(): void {
    if (this.state === AgentState.Confirming || this.state === AgentState.Executing) {
      this.transitionTo(AgentState.Executing);
    }
  }

  onExecutionDone(): void {
    if (this.siteTask && !SITE_TERMINAL.has(this.siteTask.status)) return;
    if (![AgentState.Executing, AgentState.Speaking, AgentState.Confirming].includes(this.state)) return;
    console.log("[AgentCore] Execution complete — returning to Listening state.");
    this.currentSnapshot = null;
    this.transitionTo(this.listeningEnabled ? AgentState.Listening : AgentState.Idle);
    void sendToSW({ type: "AGENT_STATE_CHANGED", state: this.state });
  }

  /**
   * Undo the last reversible action (FR-SAFE-03).
   * Pops the top entry from the undo stack, computes inverse actions,
   * wraps them in an AgentPlan, and sends them to SW to execute in the tab.
   */
  async undo(): Promise<boolean> {
    const entry = this.undoStack.undo();
    if (!entry) {
      console.warn("[AgentCore] Nothing to undo.");
      await this.tts.speak("Nothing to undo.");
      return false;
    }

    const inverseActions = this.undoStack.buildInverseActions(entry);
    if (inverseActions.length === 0) {
      console.warn("[AgentCore] Action cannot be reversed.");
      await this.tts.speak("That action cannot be automatically undone.");
      return false;
    }

    const undoPlan: AgentPlan = {
      intent: `Undo: ${entry.plan.intent}`,
      risk: RiskTier.R1,
      requiresConfirmation: false,
      actions: [
        ...inverseActions,
        { type: "done", summary: `Undid: ${entry.plan.intent}` },
      ],
    };

    console.log("[AgentCore] Executing undo plan:", undoPlan.intent);
    await sendToSW({
      type: "RELAY_ACTION",
      tabId: entry.tabId,
      plan: undoPlan,
    });

    try {
      await this.tts.speak(`Undid ${entry.plan.intent}`);
    } finally {
      await sendToSW({ type: "TTS_DONE" });
    }

    return true;
  }

  /**
   * Called when SW relays a PAGE_SNAPSHOT message.
   */
  async onPageSnapshot(snapshot: PageSnapshot): Promise<void> {
    this.currentSnapshot = snapshot;
    this.snapshotResolve?.();
    this.snapshotResolve = null;
  }

  /**
   * Called when the user answers an `ask` action.
   */
  onUserAnswer(answer: string): void {
    this.answerResolve?.(answer);
    this.answerResolve = null;
  }

  /**
   * Dispose all resources. Called when offscreen document is torn down.
   */
  dispose(): void {
    if (this.llmIdleTimer) clearTimeout(this.llmIdleTimer);
    this.llmIdleTimer = null;
    this.lifecycleId++;
    this.initializedProfile = null;
    this.speechStarted = false;
    this.operationId++;
    this.commandBusy = false;
    this.sttReadyReject?.(new Error("Agent disposed"));
    this.llmReadyReject?.(new Error("Agent disposed"));
    if (this.llmAbortTimer) clearTimeout(this.llmAbortTimer);
    this.llmAbortTimer = null;
    if (this.llmRecoveryTimer) clearTimeout(this.llmRecoveryTimer);
    this.llmRecoveryTimer = null;
    this.sttReject?.(new Error("Agent disposed"));
    for (const cb of this.llmErrorCallbacks.values()) cb("Agent disposed");
    this.llmResultCallbacks.clear();
    this.llmErrorCallbacks.clear();
    this.llmTokenCallbacks.clear();
    this.sttWorker?.terminate();
    this.llmWorker?.terminate();
    this.sttWorker = null;
    this.llmWorker = null;
    this.tts.stop();
    this.transitionTo(AgentState.Idle);
  }

  /** Stop capturing commands while keeping downloaded and initialized models in memory. */
  pauseListening(): void {
    this.listeningEnabled = false;
    this.triggerKill();
    this.transitionTo(AgentState.Idle);
    void sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Idle });
  }

  resumeListening(): void {
    this.listeningEnabled = true;
    this.transitionTo(this.isSttReady ? AgentState.Listening : AgentState.Idle);
    void sendToSW({ type: "AGENT_STATE_CHANGED", state: this.state });
    this.emitModelProgress();
  }

  onSpeechDiscard(): void {
    this.speechStarted = false;
    if (this.state === AgentState.Transcribing && !this.speechPending && !this.sttResolve) {
      this.transitionTo(this.listeningEnabled ? AgentState.Listening : AgentState.Idle);
      void sendToSW({ type: "AGENT_STATE_CHANGED", state: this.state });
    }
  }

  /** Current agent state (read-only). */
  get currentState(): AgentState {
    return this.state;
  }

  // ─── Kill Switch ───────────────────────────────────────────────────────────

  /**
   * Trigger the kill switch — stop all in-flight operations.
   * Returns to Listening within 200ms (FR-SAFE-04).
   */
  triggerKill(): void {
    this.killRequested = true;
    this.handleKill();
  }

  private handleKill(): void {
    if (this.siteTask && !SITE_TERMINAL.has(this.siteTask.status)) void sendToSW({ type: "CANCEL_SITE_TASK" });
    console.log("[AgentCore] Kill switch triggered — returning to Listening.");
    this.operationId++;
    this.speechStarted = false;
    this.commandBusy = false;
    this.tts.stop();
    const hadSttRequest = this.sttResolve !== null;
    this.sttReject?.(new Error("Speech recognition cancelled"));
    if (this.sttWorker && hadSttRequest) this.restartSTTWorker();

    // Cancel any in-flight LLM generation
    for (const requestId of this.llmResultCallbacks.keys()) {
      this.abortLLM(requestId);
      this.llmErrorCallbacks.get(requestId)?.("Planning cancelled");
    }
    this.llmResultCallbacks.clear();
    this.llmErrorCallbacks.clear();
    this.llmTokenCallbacks.clear();

    this.killRequested = false;
    this.transitionTo(this.listeningEnabled ? AgentState.Listening : AgentState.Idle);
    void sendToSW({ type: "AGENT_STATE_CHANGED", state: this.state });
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────
  onSiteTaskState(state: SiteTaskState): void {
    this.siteTask = state;
    if (["cancelled", "unknown", "limited"].includes(state.status)) {
      for (const [requestId, fail] of this.llmErrorCallbacks) { this.abortLLM(requestId); fail("Site task cancelled"); }
      this.llmResultCallbacks.clear(); this.llmErrorCallbacks.clear(); this.llmTokenCallbacks.clear();
    }
    this.transitionTo(SITE_TERMINAL.has(state.status) || state.status === "awaiting_answer" ? (this.listeningEnabled ? AgentState.Listening : AgentState.Idle)
      : state.status === "awaiting_approval" ? AgentState.Confirming : state.status === "executing" ? AgentState.Executing : AgentState.Planning);
  }

  async decideSiteTask(request: SiteDecisionRequest): Promise<SiteDecision> {
    if (this.initializedProfile === ModelProfile.Essential) throw new Error("Choose Assist or another AI profile in Settings for general site tasks.");
    await this.ensurePlannerReady();
    return this.measure("planning", () => decideSiteStep(this.buildPlannerLLMInterface(), request));
  }

  private groundFastPlan(plan: AgentPlan, snapshot: PageSnapshot): AgentPlan {
    const actions = plan.actions.map(action => {
      if (!("handle" in action) || !action.handle) return action;
      const name = action.handle.toLowerCase().trim().replace(/\s+(?:field|button|link)$/, "").replace(/^(?:number|#)\s*/, "");
      const target = /^\d+$/.test(name) ? `e${name}` : name;
      const candidates = snapshot.elements.filter(element => !element.disabled && (
        action.type !== "type" || ["input", "textarea"].includes(element.tag) || element.role === "textbox"
      ));
      let matches = candidates.filter(element => element.handle === target || element.label?.toLowerCase() === target);
      if (matches.length === 0) matches = candidates.filter(element =>
        element.label?.toLowerCase().includes(target) || element.inputType === target ||
        (target === "input" && ["input", "textarea"].includes(element.tag))
      );
      if (matches.length > 1) {
        const visible = matches.filter(element => element.inViewport);
        if (visible.length === 1) matches = visible;
      }
      if (matches.length !== 1) throw new Error(`Could not uniquely identify “${action.handle}”. Use the exact visible field or button label.`);
      const match = matches[0]!;
      if (action.type === "type" && match.inputType === "password") throw new Error("Use the vault to fill password fields.");
      return { ...action, handle: match.handle, ...(action.type === "click" ? { label: match.label ?? "" } : {}) };
    });
    return { ...plan, actions };
  }

  private async measure<T>(stage: import("../../diagnostics/metrics.js").PerformanceStage, action: () => Promise<T>): Promise<T> {
    const start = performance.now();
    let success = false;
    try { const result = await action(); success = true; return result; }
    finally { void sendToSW({ type: "PERFORMANCE_SAMPLE", sample: { stage, durationMs: performance.now() - start, success } }); }
  }

  private transitionTo(next: AgentState): void {
    console.log(`[AgentCore] ${this.state} → ${next}`);
    this.state = next;
  }

  /**
   * Build the PlannerLLMInterface that proxies through the LLM Worker.
   */
  private buildPlannerLLMInterface(): PlannerLLMInterface {
    return {
      postGenerate: (requestId: string, messages: ChatMessage[], grammar?: string): void => {
        if (!this.llmWorker || !this.isLlmReady) {
          this.handleLLMMessage({ data: { type: "error", requestId, message: this.llmCircuitOpen ? "GPU planning is unavailable. Basic commands still work; restart Chrome and retry model setup." : "AI planner is still loading or unavailable. Wait for Models ready, or use a simple command." } } as MessageEvent<LLMMessage>);
          return;
        }
        this.llmWorker.postMessage({ type: "generate", requestId, messages, grammar });
      },
      onResult: (requestId: string, cb: (text: string) => void): void => {
        this.llmResultCallbacks.set(requestId, cb);
      },
      onError: (requestId: string, cb: (message: string) => void): void => {
        this.llmErrorCallbacks.set(requestId, cb);
      },
      onToken: (requestId: string, cb: (delta: string) => void): void => {
        this.llmTokenCallbacks.set(requestId, cb);
      },
      abort: (requestId: string): void => {
        this.abortLLM(requestId);
        this.llmResultCallbacks.delete(requestId);
        this.llmErrorCallbacks.delete(requestId);
        this.llmTokenCallbacks.delete(requestId);
      },
    };
  }

  /**
   * Send audio to the STT worker and await the transcript.
   * Uses transferable ArrayBuffer for zero-copy transfer.
   */
  private async transcribe(audio: Float32Array): Promise<{ text: string; confidence: number | null; language: string }> {
    if (!this.sttWorker) throw new Error("STT worker not initialized");
    if (this.sttResolve) throw new Error("Speech recognition is busy");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sttResolve = null;
        this.sttReject = null;
        this.restartSTTWorker();
        reject(new Error(`STT timeout after ${STT_TIMEOUT_MS}ms. Speech recognition has been restarted; please retry when ready.`));
      }, STT_TIMEOUT_MS);

      this.sttResolve = (result) => {
        clearTimeout(timer);
        this.sttResolve = null;
        this.sttReject = null;
        resolve(result);
      };
      this.sttReject = (err) => {
        clearTimeout(timer);
        this.sttResolve = null;
        this.sttReject = null;
        reject(err);
      };

      // Transfer the buffer (zero-copy) — the worker owns it now.
      try {
        this.sttWorker!.postMessage({ type: "transcribe", audio }, [audio.buffer]);
      } catch (err) {
        this.sttReject?.(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Wait for the current page snapshot to be delivered via onPageSnapshot().
   */
  private async waitForSnapshot(timeoutMs = 3_000): Promise<PageSnapshot> {
    // If we already have a fresh snapshot, use it immediately.
    if (this.currentSnapshot) return this.currentSnapshot;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.snapshotResolve = null;
        console.warn("[AgentCore] Snapshot wait timed out, continuing with fallback snapshot");
        this.currentSnapshot = {
          url: "",
          title: "Current Webpage",
          elements: [],
          capturedAt: Date.now(),
          truncated: false,
        };
        resolve(this.currentSnapshot);
      }, timeoutMs);

      this.snapshotResolve = () => {
        clearTimeout(timer);
        resolve(this.currentSnapshot!);
      };
    });
  }

  /**
   * Get the current active tab ID.
   * The SW is the authority here; we pass 0 and let it resolve the active tab.
   */
  private async getActiveTabId(): Promise<number> {
    return 0; // SW resolves active tab on REQUEST_SNAPSHOT
  }

  /** Optional planning is initialized only when a complex request actually needs it. */
  async ensurePlannerReady(): Promise<void> {
    if (this.initializedProfile === ModelProfile.Essential) throw new Error("AI planning is disabled in Essential mode.");
    if (this.llmCircuitOpen) throw new Error("GPU planning is unavailable. Basic commands still work.");
    if (this.isLlmReady) return;
    this.llmRequested = true;
    if (!this.llmWorker && !this.llmRecoveryTimer) {
      this.spawnLLMWorker();
      this.llmWorker!.postMessage({ type: "load", modelId: this.llmModelId });
      this.emitModelProgress("Opening optional AI planner…");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.llmReady, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Optional planner initialization timed out. Basic commands still work.")), GPU_RECOVERY_LOAD_TIMEOUT_MS);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private spawnLLMWorker(): void {
    const worker = new Worker(new URL("../llm/llm-worker.ts", import.meta.url), { type: "module" });
    this.llmWorker = worker;
    worker.addEventListener("message", event => {
      if (this.llmWorker === worker) this.handleLLMMessage(event as MessageEvent<LLMMessage>);
    });
    worker.addEventListener("error", event => {
      if (this.llmWorker !== worker) return;
      if (isGPUDeviceLoss(event.message)) { this.recoverGPUPlanner(); return; }
      const error = new Error(`LLM worker crashed: ${event.message}`);
      if (this.llmRecoveryAttempts > 0 && !this.isLlmReady) { this.failGPURecovery(error.message); return; }
      this.isLlmReady = false;
      this.initializationFailed = true;
      this.emitModelError(error.message);
      this.llmReadyReject(error);
      for (const cb of this.llmErrorCallbacks.values()) cb(error.message);
      this.llmErrorCallbacks.clear();
      this.llmResultCallbacks.clear();
      this.llmTokenCallbacks.clear();
    });
  }

  private schedulePlannerEviction(): void {
    if (this.llmIdleTimer) clearTimeout(this.llmIdleTimer);
    this.llmIdleTimer = setTimeout(() => {
      this.llmIdleTimer = null;
      if (!this.isLlmReady || this.llmCircuitOpen) return;
      if (this.commandBusy || this.llmResultCallbacks.size) { this.schedulePlannerEviction(); return; }
      this.llmWorker?.terminate();
      this.llmWorker = null;
      this.isLlmReady = false;
      this.llmRequested = false;
      this.llmProgress = 0;
      this.llmReady = new Promise<void>((resolve, reject) => { this.llmReadyResolve = resolve; this.llmReadyReject = reject; });
      void this.llmReady.catch(() => {});
      this.emitModelProgress("Voice ready — idle planner released from GPU memory");
    }, 120_000);
  }

  private recoverGPUPlanner(): void {
    this.llmWorker?.terminate();
    this.llmWorker = null;
    this.isLlmReady = false;
    this.llmProgress = 0;
    this.llmDownloading = false;
    if (this.llmAbortTimer) clearTimeout(this.llmAbortTimer);
    this.llmAbortTimer = null;
    if (this.llmRecoveryTimer) clearTimeout(this.llmRecoveryTimer);
    this.llmRecoveryTimer = null;

    const callbacks = [...this.llmErrorCallbacks.values()];
    this.llmErrorCallbacks.clear();
    this.llmResultCallbacks.clear();
    this.llmTokenCallbacks.clear();
    const canRecover = this.llmRecoveryAttempts === 0;
    const message = canRecover
      ? "GPU device lost. Loading a smaller AI planner; wait for Models ready, then repeat your command. Basic commands still work."
      : "GPU device was lost again. Complex planning is disabled to avoid repeated GPU crashes. Basic commands still work. Restart Chrome or free GPU resources, then retry model setup.";

    if (canRecover) {
      this.llmRecoveryAttempts++;
      this.llmModelId = GPU_RECOVERY_MODEL;
      // Bridge the old readiness promise: setup may already be awaiting it.
      const previousResolve = this.llmReadyResolve;
      const previousReject = this.llmReadyReject;
      this.llmReady = new Promise<void>((resolve, reject) => {
        this.llmReadyResolve = () => { resolve(); previousResolve(); };
        this.llmReadyReject = error => { reject(error); previousReject(error); };
      });
      void this.llmReady.catch(() => {});
      this.emitModelProgress("GPU reset — opening a smaller AI planner…");
      this.llmRecoveryTimer = setTimeout(() => {
        this.llmRecoveryTimer = null;
        this.spawnLLMWorker();
        this.llmWorker!.postMessage({ type: "load", modelId: this.llmModelId });
        this.llmRecoveryTimer = setTimeout(() => {
          this.llmRecoveryTimer = null;
          this.failGPURecovery("The smaller AI planner could not load within five minutes. Basic commands still work; retry model setup when ready.");
        }, GPU_RECOVERY_LOAD_TIMEOUT_MS);
      }, GPU_RECOVERY_DELAY_MS);
    } else {
      this.failGPURecovery(message);
    }
    // Never replay a failed command using a stale page snapshot.
    for (const callback of callbacks) callback(message);
  }

  private failGPURecovery(message: string): void {
    if (this.llmRecoveryTimer) clearTimeout(this.llmRecoveryTimer);
    this.llmRecoveryTimer = null;
    this.llmWorker?.terminate();
    this.llmWorker = null;
    this.isLlmReady = false;
    this.llmCircuitOpen = true;
    this.emitModelError(message);
    this.llmReadyReject(new Error(message));
  }

  private abortLLM(requestId: string): void {
    this.llmWorker?.postMessage({ type: "abort", requestId });
    if (this.llmAbortTimer) clearTimeout(this.llmAbortTimer);
    // A wedged GPU may never yield a token or acknowledge interruptGenerate.
    this.llmAbortTimer = setTimeout(() => {
      this.llmAbortTimer = null;
      this.llmWorker?.terminate();
      this.isLlmReady = false;
      this.llmProgress = 0;
      this.llmReady = new Promise<void>((resolve, reject) => {
        this.llmReadyResolve = resolve;
        this.llmReadyReject = reject;
      });
      void this.llmReady.catch(() => {});
      this.spawnLLMWorker();
      this.llmWorker!.postMessage({ type: "load", modelId: this.llmModelId });
    }, 2_000);
  }

  private spawnSTTWorker(): void {
    const worker = new Worker(new URL("../stt/stt-worker.ts", import.meta.url), { type: "module" });
    this.sttWorker = worker;
    worker.addEventListener("message", event => {
      if (this.sttWorker === worker) this.handleSTTMessage(event as MessageEvent<STTMessage>);
    });
    worker.addEventListener("error", event => {
      if (this.sttWorker !== worker) return;
      const error = new Error(`STT worker crashed: ${event.message}`);
      this.sttReadyReject(error);
      this.sttReject?.(error);
      this.restartSTTWorker();
    });
  }

  private restartSTTWorker(): void {
    this.sttWorker?.terminate();
    this.isSttReady = false;
    this.sttProgress = 0;
    this.sttReady = new Promise<void>((resolve, reject) => {
      this.sttReadyResolve = resolve;
      this.sttReadyReject = reject;
    });
    void this.sttReady.catch(() => {});
    this.spawnSTTWorker();
    this.sttWorker!.postMessage({ type: "load", modelId: this.sttModelId });
  }

  /**
   * Reset the STT/LLM readiness promises.
   * Called in constructor and when workers are restarted.
   */
  private resetReadinessPromises(): void {
    this.sttReady = new Promise<void>((resolve, reject) => {
      this.sttReadyResolve = resolve;
      this.sttReadyReject = reject;
    });
    void this.sttReady.catch(() => {});
    this.llmReady = new Promise<void>((resolve, reject) => {
      this.llmReadyResolve = resolve;
      this.llmReadyReject = reject;
    });
    void this.llmReady.catch(() => {});
  }

  /**
   * Emit weighted model download progress to SW (panel & onboarding).
   * Whisper STT = 15% weight, WebLLM = 85% weight.
   * Only emits done === true when BOTH STT and LLM workers are ready.
   */
  private emitModelProgress(detailText?: string): void {
    const plannerRequested = this.llmRequested;
    const isAllReady = this.isSttReady && (!plannerRequested || this.isLlmReady);
    if (isAllReady) this.initializationFailed = false;
    const weightedProgress = isAllReady ? 1.0 : plannerRequested ? (this.sttProgress * 0.15 + this.llmProgress * 0.85) : this.sttProgress;
    const pct = isAllReady ? 100 : Math.min(99, Math.round(weightedProgress * 100));

    let text = detailText;
    if (isAllReady) {
      text = !plannerRequested ? "Voice ready — optional planner not loaded" : this.llmModelId === GPU_RECOVERY_MODEL ? "Models ready — compact planner active" : "✓ Models ready!";
    } else if (!text) {
      if (!this.isSttReady) {
        text = this.sttProgress > 0 ? `Preparing speech model… ${Math.round(this.sttProgress * 100)}%` : "Opening saved speech model…";
      } else {
        text = this.llmProgress > 0 ? `Preparing AI planner… ${Math.round(this.llmProgress * 100)}%` : "Opening saved AI planner…";
      }
    }

    void sendToSW({
      type: "MODEL_LOAD_PROGRESS",
      profile: this.initializedProfile ?? undefined,
      loadId: this.loadId,
      progress: isAllReady ? 1.0 : weightedProgress,
      loaded: pct,
      total: 100,
      done: isAllReady,
      phase: isAllReady ? "ready" : (this.sttDownloading || this.llmDownloading ? "downloading" : "loading"),
      text,
      stt: {
        loaded: Math.round(this.sttProgress * 100),
        total: 100,
        ready: this.isSttReady,
      },
      llm: {
        loaded: Math.round(this.llmProgress * 100),
        total: 100,
        ready: this.isLlmReady,
        text: detailText,
      },
    } as any);
  }

  private emitModelError(message: string): void {
    this.initializationFailed = true;
    void sendToSW({ type: "MODEL_LOAD_PROGRESS", profile: this.initializedProfile ?? undefined,
      loadId: this.loadId, progress: 0, loaded: 0, total: 100, done: false, phase: "error", text: message } as any);
  }

  /**
   * Explicitly load models for a given profile (e.g. from Onboarding).
   */
  async loadProfile(profile: ModelProfile): Promise<void> {
    // Explicit setup/retry is allowed to reopen the circuit; mic pause/resume is not.
    if (this.llmCircuitOpen) {
      this.llmCircuitOpen = false;
      this.initializationFailed = true;
    }
    // Recreate workers so profile changes cannot race with native inference/loading.
    await this.initialize(profile);
    if (this.initializedProfile !== profile) throw new DOMException("Model selection changed", "AbortError");
    const loadId = this.loadId;
    try {
      await this.sttReady;
    } catch (err) {
      if (this.initializedProfile !== profile || loadId !== this.loadId) throw new DOMException("Model selection changed", "AbortError");
      throw err;
    }
  }

  // ─── Worker Message Handlers ───────────────────────────────────────────────

  /** Handle messages from the STT worker. */
  private handleSTTMessage(event: MessageEvent<STTMessage>): void {
    const msg = event.data;

    switch (msg.type) {
      case "ready":
        console.log("[AgentCore] STT worker ready.");
        this.sttProgress = 1.0;
        this.isSttReady = true;
        this.sttDownloading = false;
        this.sttReadyResolve();
        this.emitModelProgress("Speech recognition ready.");
        break;

      case "result":
        this.sttResolve?.({ text: msg.text, confidence: msg.confidence, language: msg.language });
        break;

      case "error":
        if (!this.isSttReady) this.emitModelError(msg.message);
        this.sttReadyReject?.(new Error(msg.message));
        this.sttReject?.(new Error(msg.message));
        break;

      case "progress":
        this.sttDownloading = msg.downloading ?? false;
        if (msg.total > 0) {
          this.sttProgress = Math.max(this.sttProgress, Math.min(0.99, msg.loaded / msg.total));
        }
        this.emitModelProgress();
        break;

      default: {
        const _exhaustive: never = msg;
        console.warn("[AgentCore] Unknown STT message:", _exhaustive);
      }
    }
  }

  /** Handle messages from the LLM worker. */
  private handleLLMMessage(event: MessageEvent<LLMMessage>): void {
    const msg = event.data;

    switch (msg.type) {
      case "ready":
        this.schedulePlannerEviction();
        if (this.llmRecoveryTimer) clearTimeout(this.llmRecoveryTimer);
        this.llmRecoveryTimer = null;
        console.log("[AgentCore] LLM worker ready.");
        this.llmProgress = 1.0;
        this.isLlmReady = true;
        this.llmDownloading = false;
        this.llmReadyResolve();
        this.emitModelProgress("AI planner ready.");
        break;

      case "cancelled":
        if (this.llmAbortTimer) clearTimeout(this.llmAbortTimer);
        this.llmAbortTimer = null;
        break;

      case "progress":
        this.llmDownloading = msg.downloading ?? false;
        if (msg.total > 0) {
          this.llmProgress = Math.max(this.llmProgress, Math.min(0.99, msg.loaded / msg.total));
        }
        this.emitModelProgress(this.llmDownloading ? "Downloading AI model…" : "Preparing AI planner…");
        break;

      case "token": {
        // Stream token to panel AND to any registered token callback (for Planner streaming).
        const tokenCb = this.llmTokenCallbacks.get(msg.requestId);
        tokenCb?.(msg.delta);

        // Also forward to panel for live display.
        if (this.llmResultCallbacks.has(msg.requestId)) void sendToSW({ type: "LLM_TOKEN", delta: msg.delta } as any);
        break;
      }

      case "result": {
        this.schedulePlannerEviction();
        const resultCb = this.llmResultCallbacks.get(msg.requestId);
        this.llmResultCallbacks.delete(msg.requestId);
        this.llmErrorCallbacks.delete(msg.requestId);
        this.llmTokenCallbacks.delete(msg.requestId);

        console.log(
          `[AgentCore] LLM result for "${msg.requestId}": ` +
          `${msg.usage.completion_tokens} tokens, ${msg.text.length} chars`
        );
        resultCb?.(msg.text);
        break;
      }

      case "error": {
        if (msg.code === "GPU_DEVICE_LOST" || isGPUDeviceLoss(msg.message)) {
          this.recoverGPUPlanner();
          break;
        }
        if (!msg.requestId && this.llmRecoveryAttempts > 0 && !this.isLlmReady) {
          this.failGPURecovery(`The smaller AI planner could not open: ${msg.message}. Basic commands still work; retry model setup.`);
          break;
        }
        if (!msg.requestId) {
          this.emitModelError(msg.message);
          this.llmReadyReject?.(new Error(msg.message));
        }
        const errorCb = this.llmErrorCallbacks.get(msg.requestId);
        this.llmResultCallbacks.delete(msg.requestId);
        this.llmErrorCallbacks.delete(msg.requestId);
        this.llmTokenCallbacks.delete(msg.requestId);

        console.error(`[AgentCore] LLM error for "${msg.requestId}":`, msg.message);
        errorCb?.(msg.message);
        break;
      }

      default: {
        const _exhaustive: never = msg;
        console.warn("[AgentCore] Unknown LLM message:", _exhaustive);
      }
    }
  }
}
