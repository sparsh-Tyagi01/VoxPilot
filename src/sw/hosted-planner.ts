import { buildSiteDecisionInput } from "../offscreen/agent/site-planner.js";
import { parseSiteDecision } from "@shared/site-schema.js";
import { validateHostedSettings, type HostedPlannerSettings } from "@shared/hosted-planner.js";
import type { SiteDecisionRequest, SiteDecision } from "@shared/site-task.js";

interface Configuration { config: HostedPlannerSettings; apiKey: string; }
const MAX_RESPONSE_BYTES = 64 * 1024;
const stopped = () => new DOMException("Hosted planning stopped.", "AbortError");
async function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw stopped();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(stopped()); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([operation(), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** One request at a time, no retries or fallback, no browser authority in a response. */
export class HostedPlanner {
  private epoch = 0;
  private controller: AbortController | null = null;
  constructor(private readonly read: () => Promise<Configuration>, private readonly transport: typeof fetch = fetch) {}
  cancel(): void { this.epoch++; this.controller?.abort(); }

  async decide(request: SiteDecisionRequest, current: () => boolean): Promise<SiteDecision> {
    if (this.controller) throw new Error("Hosted planning is busy. Stop the current task first.");
    const epoch = this.epoch;
    const configured = await this.read();
    if (epoch !== this.epoch || !current()) throw stopped();
    const config = validateHostedSettings(configured.config);
    if (!config.enabled) throw new Error("Hosted planning is disabled. Enable it explicitly in Settings → Model, or choose a local profile.");
    // Another request may have entered while settings were being read.
    if (this.controller) throw new Error("Hosted planning is busy. Stop the current task first.");
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(25_000, request.remainingMs)));
    try {
      return await abortable(controller.signal, async () => {
        const safeURL = (value: string): string => { try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; } catch { return ""; } };
        const observation = request.observation;
        const input = buildSiteDecisionInput({ ...request, observation: { ...observation, url: safeURL(observation.url),
          elements: observation.elements.map(el => { const { href, ...rest } = el; return { ...rest, ...(href && safeURL(href) === href ? { href } : {}) }; }),
          forms: observation.forms.map(form => ({ ...form, action: safeURL(form.action) })) } });
        input.messages[0]!.content += `\nYour JSON decision must match this schema: ${input.grammar}`;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (configured.apiKey) headers["Authorization"] = `Bearer ${configured.apiKey}`;
        const transport = this.transport;
        const response = await transport(config.endpoint, { method: "POST", headers, signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
          body: JSON.stringify({ model: config.model, messages: input.messages, response_format: { type: "json_object" }, max_tokens: 384, stream: false, store: false }) });
        if (controller.signal.aborted || epoch !== this.epoch || !current()) { await response.body?.cancel(); throw stopped(); }
        if (!response.ok) {
          await response.body?.cancel();
          if ([401, 403].includes(response.status)) throw new Error("Hosted service rejected the credentials. Update the session API key in Settings → Model.");
          if (response.status === 429) throw new Error("Hosted service rate limit reached. Wait before starting another request.");
          throw new Error(`Hosted service returned HTTP ${response.status}. Check its endpoint, model and JSON-mode support in Settings → Model.`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Hosted service returned an empty response.");
        let size = 0, text = ""; const decoder = new TextDecoder();
        try {
          let chunk = await reader.read();
          while (!chunk.done) {
            size += chunk.value.byteLength;
            if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("Hosted response exceeded its size limit. That decision was rejected."); }
            text += decoder.decode(chunk.value, { stream: true });
            chunk = await reader.read();
          }
          text += decoder.decode();
        } finally { reader.releaseLock(); }
        if (controller.signal.aborted || epoch !== this.epoch || !current()) throw stopped();
        let value: unknown; try { value = JSON.parse(text); } catch { throw new Error("Hosted service returned invalid JSON. No action was dispatched for that decision."); }
        const envelope = value as { choices?: { finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown; tool_calls?: unknown } }[] } | null;
        const choice = envelope?.choices?.[0];
        if (choice?.finish_reason !== "stop" || choice.message?.refusal || choice.message?.tool_calls || typeof choice.message?.content !== "string") throw new Error("Hosted service did not return one complete decision. No action was dispatched for that decision.");
        try { return parseSiteDecision(choice.message.content); }
        catch { throw new Error("Hosted service returned an invalid site decision. Try a more specific request or continue manually."); }
      });
    } catch (error) {
      if (epoch !== this.epoch || !current()) throw stopped();
      if (controller.signal.aborted) throw new Error("Hosted planning timed out or was interrupted. Check the page before trying again.");
      if (error instanceof TypeError) throw new Error("Could not reach the hosted service. Check the endpoint, connection and browser access settings.");
      throw error;
    } finally { clearTimeout(timer); if (this.controller === controller) this.controller = null; }
  }
}
