import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentState, RiskTier } from "../src/shared/types.js";
import type { AgentPlan, SessionState } from "../src/shared/types.js";
import { SESSION_KEYS } from "../src/shared/constants.js";
import { EXECUTION_RECEIPT_KEY } from "../src/sw/execution-journal.js";

const history = vi.hoisted(() => ({ append: vi.fn(async () => undefined) }));
vi.mock("../src/shared/history.js", () => ({
  appendHistory: history.append, clearHistory: vi.fn(async () => undefined),
  loadHistory: vi.fn(async () => []), generateHistoryId: () => "history-id",
}));

type MessageListener = (message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean;
let handleMessage: MessageListener;
let session: Record<string, unknown>;
let local: Record<string, unknown>;
let api: ReturnType<typeof createChrome>;
let pageFailure: string | null;

function createChrome() {
  const area = (data: Record<string, unknown>) => ({
    get: vi.fn(async (key: string) => structuredClone({ [key]: data[key] })),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }),
    remove: vi.fn(async (key: string) => { delete data[key]; }),
  });
  const event = () => ({ addListener: vi.fn() });
  return {
    storage: { session: area(session), local: area(local) },
    runtime: {
      id: "voxpilot",
      onMessage: { addListener: vi.fn((listener: MessageListener) => { handleMessage = listener; }), removeListener: vi.fn() },
      sendMessage: vi.fn(async (_message: unknown) => ({ ok: true })),
      getURL: (path: string) => `chrome-extension://voxpilot/${path}`,
      getManifest: () => ({ content_scripts: [{ js: ["content.js"] }] }),
      onInstalled: event(), onStartup: event(), OnInstalledReason: { INSTALL: "install" }, lastError: undefined,
    },
    tabs: {
      query: vi.fn(async () => [{ id: 12, windowId: 1, index: 0, active: true, url: "https://example.com" }]),
      sendMessage: vi.fn((_tab: number, message: { type: string }, _options: unknown, callback: (value: unknown) => void) => {
        callback(message.type === "CAPTURE_SNAPSHOT"
          ? { type: "SNAPSHOT_RESPONSE", snapshot: { documentId: "macro-document", url: "https://example.com", title: "test", capturedAt: 1, truncated: false, elements: [{ handle: "e100", label: "Submit" }] } }
          : message.type === "EXECUTE_IN_PAGE"
          ? { type: "EXECUTION_DONE", success: !pageFailure, ...(pageFailure ? { error: pageFailure } : {}) }
          : { ok: true });
      }),
      create: vi.fn(), update: vi.fn(), remove: vi.fn(), get: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(),
    },
    offscreen: { hasDocument: vi.fn(async () => true), createDocument: vi.fn(), closeDocument: vi.fn(), Reason: { USER_MEDIA: "USER_MEDIA", WORKERS: "WORKERS" } },
    action: { setBadgeText: vi.fn(async () => undefined), setBadgeBackgroundColor: vi.fn(async () => undefined), setTitle: vi.fn(async () => undefined) },
    commands: { onCommand: event() }, alarms: { onAlarm: event(), create: vi.fn() }, scripting: { executeScript: vi.fn() },
  };
}
const state = (): SessionState => ({
  agentState: AgentState.Listening, activeTabId: 12, lastTranscript: "submit", currentPlan: null,
  offscreenActive: true, listeningEnabled: true, lastKeepalive: Date.now(), errorCount: 0,
});
const confirmedPlan: AgentPlan = {
  intent: "Submit form", risk: RiskTier.R3, requiresConfirmation: true,
  actions: [{ type: "click", handle: "e1", label: "Submit" }, { type: "done", summary: "Submitted." }],
};
const request = (message: unknown): Promise<Record<string, unknown>> => new Promise(resolve => { handleMessage(message, { id: "voxpilot", url: `chrome-extension://voxpilot/${["START_SITE_TASK", "AGENT_STATE_CHANGED", "AUDIO_LEVEL", "MODEL_LOAD_PROGRESS", "TRANSCRIPT", "PLAN_PRODUCED", "REQUEST_SNAPSHOT", "OFFSCREEN_ERROR", "TTS_DONE", "LLM_TOKEN", "PERFORMANCE_SAMPLE", "RELAY_ACTION"].includes((message as { type: string }).type) ? "src/offscreen/offscreen.html" : "src/panel/panel.html"}` }, value => resolve(value as Record<string, unknown>)); });
const executeCalls = () => api.tabs.sendMessage.mock.calls.filter(([, message]) => message.type === "EXECUTE_IN_PAGE");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  session = { [SESSION_KEYS.SESSION_STATE]: state() };
  local = { selected_profile: "lite" };
  pageFailure = null;
  api = createChrome();
  vi.stubGlobal("chrome", api);
  await import("../src/sw/sw.js");
});
afterEach(() => vi.unstubAllGlobals());

describe("service worker orchestration", () => {
  it("restores a site task as unknown after restart without retaining approval or replaying it", async () => {
    session[SESSION_KEYS.SESSION_STATE] = { ...state(), siteTask: { version: 1, id: "site-1", tabId: 12, origin: "https://example.com", goal: "Add item", status: "awaiting_approval", steps: 0, message: "Waiting", approval: { id: "old", description: "Add item", context: "", destination: "", expiresAt: Date.now() + 60_000 } } };
    const restored = await request({ type: "GET_SESSION_STATE" });
    expect(restored).toMatchObject({ siteTask: { status: "unknown" } });
    expect((restored["siteTask"] as Record<string, unknown>)["approval"]).toBeUndefined();
    expect(executeCalls()).toHaveLength(0);
    expect(await request({ type: "SITE_TASK_APPROVE", taskId: "site-1", approvalId: "old", approved: true })).toMatchObject({ ok: false });
  });
  it("routes a general task to the real offscreen decision boundary and publishes a scoped limitation", async () => {
    api.tabs.sendMessage.mockImplementation((_tab, message, _options, callback) => {
      callback(message.type === "SITE_OBSERVE" ? { type: "SITE_OBSERVATION", observation: {
        documentId: "doc", observationId: "observation", stateKey: "state", url: "https://example.com", title: "Page", textSummary: "An article about books", elements: [], forms: [], coverage: { candidates: 0, inspected: 0, limited: false, frames: "top_only" }, capturedAt: 1, truncated: false,
      } } : message.type === "SITE_VALIDATE" ? { type: "SITE_VALIDATION", valid: true } : { ok: true });
    });
    api.runtime.sendMessage.mockImplementation(async raw => {
      const message = raw as { type: string };
      return message.type === "SITE_DECIDE" ? { ok: true, decision: { kind: "unavailable", reason: "not_found_in_scope", message: "No cart control was found here." } } : { ok: true };
    });
    expect(await request({ type: "START_SITE_TASK", goal: "Add this to cart" })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(session[SESSION_KEYS.SESSION_STATE]).toMatchObject({ siteTask: { status: "limited", message: "On the inspected page: No cart control was found here." } }));
    expect(api.runtime.sendMessage.mock.calls.some(([message]) => (message as { type: string }).type === "SITE_DECIDE")).toBe(true);
    expect(executeCalls()).toHaveLength(0);
  });
  it("interrupts old execution after worker restart without replaying page actions", async () => {
    session[SESSION_KEYS.SESSION_STATE] = { ...state(), agentState: AgentState.Executing, currentPlan: confirmedPlan, executionId: "interrupted" };
    session[EXECUTION_RECEIPT_KEY] = { executionId: "interrupted", status: "running", updatedAt: Date.now(), steps: [{ index: 0, kind: "click", status: "dispatched" }] };
    expect(await request({ type: "GET_SESSION_STATE" })).toMatchObject({ currentPlan: null, executionId: null, agentState: AgentState.Listening });
    expect(session[EXECUTION_RECEIPT_KEY]).toMatchObject({ status: "interrupted", steps: [{ status: "uncertain" }] });
    expect(executeCalls()).toHaveLength(0);
    expect(await request({ type: "CONFIRM_PLAN" })).toMatchObject({ ok: false });
  });
  it("does not answer offscreen or UI messages and steal another context's response", () => {
    for (const target of ["offscreen", "ui"]) {
      const respond = vi.fn();
      expect(handleMessage({ type: "GET_SESSION_STATE", target }, {}, respond)).toBe(false);
      expect(respond).not.toHaveBeenCalled();
    }
  });

  it("restores model readiness from the live offscreen session when the popup reopens", async () => {
    const status = { type: "MODEL_LOAD_PROGRESS", profile: "essential", phase: "ready", done: true, progress: 1 };
    await request(status);
    expect(await request({ type: "GET_MODEL_STATUS" })).toEqual(status);
    expect(api.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it("does not present stale ready status after the offscreen document is gone", async () => {
    session["model_load_status"] = { type: "MODEL_LOAD_PROGRESS", done: true, phase: "ready", profile: "essential" };
    api.offscreen.hasDocument.mockResolvedValue(false);
    expect(await request({ type: "GET_MODEL_STATUS" })).toMatchObject({ phase: "idle", done: false });
  });

  it("pauses the microphone without closing models, and resumes using the same document", async () => {
    expect(await request({ type: "TOGGLE_LISTENING" })).toEqual({ ok: true });
    expect(api.runtime.sendMessage).toHaveBeenCalledWith({ type: "STOP_AUDIO", target: "offscreen" });
    expect(session[SESSION_KEYS.SESSION_STATE]).toMatchObject({ listeningEnabled: false, agentState: AgentState.Idle });
    expect(api.offscreen.closeDocument).not.toHaveBeenCalled();
    expect(await request({ type: "TOGGLE_LISTENING" })).toEqual({ ok: true });
    expect(api.runtime.sendMessage).toHaveBeenCalledWith({ type: "START_AUDIO", target: "offscreen", profile: "lite" });
    expect(api.offscreen.createDocument).not.toHaveBeenCalled();
    expect(session[SESSION_KEYS.SESSION_STATE]).toMatchObject({ listeningEnabled: true });
  });

  it("keeps cached model readiness when setup requests the same live profile", async () => {
    const ready = { type: "MODEL_LOAD_PROGRESS", profile: "essential", phase: "ready", done: true, progress: 1 };
    session["model_load_status"] = ready;
    expect(await request({ type: "START_MODEL_DOWNLOAD", profile: "lite" })).toEqual({ ok: true });
    expect(session["model_load_status"]).toEqual(ready);
    expect(api.offscreen.createDocument).not.toHaveBeenCalled();
    expect(api.runtime.sendMessage).toHaveBeenCalledWith({ type: "START_MODEL_DOWNLOAD", profile: "lite", target: "offscreen" });
  });

  it("waits for confirmation, executes the approved DOM action once, and rejects stale approval", async () => {
    expect(await request({ type: "PLAN_PRODUCED", plan: confirmedPlan })).toEqual({ ok: true });
    expect(executeCalls()).toHaveLength(0);
    expect(session[SESSION_KEYS.SESSION_STATE]).toMatchObject({ agentState: AgentState.Confirming });
    expect(await request({ type: "CONFIRM_PLAN" })).toEqual({ ok: true });
    expect(executeCalls()).toHaveLength(1);
    expect(api.runtime.sendMessage).toHaveBeenCalledWith({ type: "EXECUTION_DONE", success: true, target: "offscreen" });
    expect(await request({ type: "CONFIRM_PLAN" })).toMatchObject({ ok: false });
    expect(executeCalls()).toHaveLength(1);
  });

  it("keeps the original document identity through confirmation and page execution", async () => {
    await request({ type: "PLAN_PRODUCED", plan: confirmedPlan, documentId: "original-document" });
    await request({ type: "CONFIRM_PLAN" });
    expect(executeCalls()[0]?.[1]).toMatchObject({ documentId: "original-document" });
  });

  it("grounds macro targets freshly and requires confirmation for submission", async () => {
    local["voxpilot_macros_v1"] = [{ id: "macro-1", name: "Submit", actions: [{ type: "click", handle: "e1", label: "Submit" }], useCount: 0 }];
    expect(await request({ type: "TRIGGER_MACRO", macroId: "macro-1" })).toMatchObject({ ok: true });
    expect(executeCalls()).toHaveLength(0);
    expect(session[SESSION_KEYS.SESSION_STATE]).toMatchObject({ agentState: AgentState.Confirming, currentPlan: { requiresConfirmation: true } });
    await request({ type: "CONFIRM_PLAN" });
    expect(executeCalls()[0]?.[1]).toMatchObject({ documentId: "macro-document", plan: { actions: [{ type: "click", handle: "e100", label: "Submit" }] } });
    expect(session[EXECUTION_RECEIPT_KEY]).toMatchObject({ status: "completed" });
  });

  it("claims a pending approval atomically when popup and page confirm together", async () => {
    await request({ type: "PLAN_PRODUCED", plan: confirmedPlan });
    const replies = await Promise.all([request({ type: "CONFIRM_PLAN" }), request({ type: "CONFIRM_PLAN" })]);
    expect(replies.filter(reply => reply["ok"] === true)).toHaveLength(1);
    expect(replies.filter(reply => reply["ok"] === false)).toHaveLength(1);
    expect(executeCalls()).toHaveLength(1);
  });

  it("does not report successful completion or replay a failed DOM action through guessed scripting", async () => {
    pageFailure = "The form changed. Refresh and retry.";
    const result = await request({ type: "PLAN_PRODUCED", plan: { ...confirmedPlan, risk: RiskTier.R1, requiresConfirmation: false, actions: [{ type: "click", handle: "e1", label: "Expand" }] } });
    expect(result).toMatchObject({ ok: false, error: pageFailure });
    expect(executeCalls()).toHaveLength(1);
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    expect(history.append).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(session[SESSION_KEYS.SESSION_STATE]).toMatchObject({ agentState: AgentState.Error }));
    expect(api.runtime.sendMessage.mock.calls.some(([message]) => {
      const value = message as { type?: string; success?: boolean };
      return value.type === "EXECUTION_DONE" && value.success === true;
    })).toBe(false);
  });
  it("does not wait for spoken feedback to finish a verified action", async () => {
    local["voice_settings"] = { spokenConfirmations: true };
    api.runtime.sendMessage.mockImplementation(async (message: unknown) => {
      if ((message as { type: string }).type === "SPEAK") return new Promise(() => {});
      return { ok: true };
    });
    const result = await request({ type: "PLAN_PRODUCED", plan: { intent: "scroll", risk: 0, requiresConfirmation: false, actions: [{ type: "scroll", direction: "down" }, { type: "done", summary: "Scrolled" }] } });
    expect(result.ok).toBe(true);
    const current = session[SESSION_KEYS.SESSION_STATE] as SessionState;
    expect(current.agentState).toBe(AgentState.Listening);
  });
  it("a late TTS failure cannot invalidate a newer command", async () => {
    session[SESSION_KEYS.SESSION_STATE] = { ...state(), agentState: AgentState.Planning };
    await request({ type: "OFFSCREEN_ERROR", source: "tts", message: "voice unavailable" });
    expect((session[SESSION_KEYS.SESSION_STATE] as SessionState).agentState).toBe(AgentState.Planning);
  });

});
