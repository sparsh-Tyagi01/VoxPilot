import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentState, RiskTier } from "../src/shared/types.js";
import type { AgentPlan, SessionState } from "../src/shared/types.js";
import { SESSION_KEYS } from "../src/shared/constants.js";

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
      onMessage: { addListener: vi.fn((listener: MessageListener) => { handleMessage = listener; }), removeListener: vi.fn() },
      sendMessage: vi.fn(async (_message: unknown) => ({ ok: true })),
      getURL: (path: string) => `chrome-extension://voxpilot/${path}`,
      getManifest: () => ({ content_scripts: [{ js: ["content.js"] }] }),
      onInstalled: event(), onStartup: event(), OnInstalledReason: { INSTALL: "install" }, lastError: undefined,
    },
    tabs: {
      query: vi.fn(async () => [{ id: 12, windowId: 1, index: 0, active: true, url: "https://example.com" }]),
      sendMessage: vi.fn((_tab: number, message: { type: string }, _options: unknown, callback: (value: unknown) => void) => {
        callback(message.type === "EXECUTE_IN_PAGE"
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
const request = (message: unknown): Promise<Record<string, unknown>> => new Promise(resolve => { handleMessage(message, { id: "voxpilot" }, value => resolve(value as Record<string, unknown>)); });
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
  it("does not answer offscreen or UI messages and steal another context's response", () => {
    for (const target of ["offscreen", "ui"]) {
      const respond = vi.fn();
      expect(handleMessage({ type: "GET_SESSION_STATE", target }, {}, respond)).toBe(false);
      expect(respond).not.toHaveBeenCalled();
    }
  });

  it("restores model readiness from the live offscreen session when the popup reopens", async () => {
    const status = { type: "MODEL_LOAD_PROGRESS", profile: "fast", phase: "ready", done: true, progress: 1 };
    await request(status);
    expect(await request({ type: "GET_MODEL_STATUS" })).toEqual(status);
    expect(api.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it("does not present stale ready status after the offscreen document is gone", async () => {
    session["model_load_status"] = { type: "MODEL_LOAD_PROGRESS", done: true, phase: "ready", profile: "fast" };
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
    const ready = { type: "MODEL_LOAD_PROGRESS", profile: "fast", phase: "ready", done: true, progress: 1 };
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
});
