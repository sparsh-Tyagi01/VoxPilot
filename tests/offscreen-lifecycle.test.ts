import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  initialize: vi.fn(), loadProfile: vi.fn(), resume: vi.fn(), pause: vi.fn(), dispose: vi.fn(), captureStart: vi.fn(), captureStop: vi.fn(), vadStart: vi.fn(), vadStop: vi.fn(),
  coreInstances: 0,
}));
vi.mock("../src/offscreen/agent/agent-core.js", () => ({ AgentCore: class {
  constructor() { mock.coreInstances++; }
  initialize = mock.initialize; loadProfile = mock.loadProfile; resumeListening = mock.resume; pauseListening = mock.pause; dispose = mock.dispose;
} }));
vi.mock("../src/offscreen/audio/capture.js", () => ({ AudioCapture: class { start = mock.captureStart; stop = mock.captureStop; } }));
vi.mock("../src/offscreen/audio/vad.js", () => ({ VAD: class { start = mock.vadStart; stop = mock.vadStop; } }));
vi.mock("../src/offscreen/audio/tts.js", () => ({ TTS: class { stop() {} } }));

type Listener = (message: unknown, sender: unknown, respond: (result: unknown) => void) => boolean;
let listener: Listener;
const request = (message: unknown) => new Promise<{ ok: boolean; error?: string }>(resolve => listener(message, {}, result => resolve(result as { ok: boolean; error?: string })));
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); mock.coreInstances = 0;
  mock.initialize.mockResolvedValue(undefined); mock.loadProfile.mockResolvedValue(undefined);
  mock.captureStart.mockResolvedValue(undefined); mock.vadStart.mockResolvedValue(undefined);
  vi.stubGlobal("chrome", { runtime: { onMessage: { addListener: (fn: Listener) => { listener = fn; } }, sendMessage: vi.fn(async () => ({ ok: true })) } });
  await import("../src/offscreen/offscreen.js");
});
afterEach(() => vi.unstubAllGlobals());

describe("offscreen audio ownership", () => {
  it("does not respond to popup requests owned by the service worker", () => {
    const respond = vi.fn();
    expect(listener({ type: "GET_SESSION_STATE" }, {}, respond)).toBe(false);
    expect(listener({ type: "MODEL_LOAD_PROGRESS", target: "ui" }, {}, respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });
  it("reuses setup's core across repeated mic starts and pauses", async () => {
    await request({ type: "START_MODEL_DOWNLOAD", profile: "lite", target: "offscreen" });
    await request({ type: "START_AUDIO", profile: "lite", target: "offscreen" });
    await request({ type: "START_AUDIO", profile: "lite", target: "offscreen" });
    expect(mock.captureStart).toHaveBeenCalledOnce();
    await request({ type: "STOP_AUDIO", target: "offscreen" });
    await request({ type: "START_AUDIO", profile: "lite", target: "offscreen" });
    expect(mock.coreInstances).toBe(1);
    expect(mock.dispose).not.toHaveBeenCalled();
    expect(mock.pause).toHaveBeenCalledOnce();
    expect(mock.captureStop).toHaveBeenCalledOnce();
    expect(mock.captureStart).toHaveBeenCalledTimes(2);
  });
  it("releases partial audio resources and returns a real mic failure", async () => {
    mock.captureStart.mockRejectedValueOnce(new Error("permission denied"));
    const failed = await request({ type: "START_AUDIO", target: "offscreen" });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("permission denied");
    expect(mock.captureStop).toHaveBeenCalledOnce();
    expect((await request({ type: "START_AUDIO", target: "offscreen" })).ok).toBe(true);
    expect(mock.coreInstances).toBe(1);
  });
  it("serializes concurrent audio starts to a single capture", async () => {
    await Promise.all([request({ type: "START_AUDIO", target: "offscreen" }), request({ type: "START_AUDIO", target: "offscreen" })]);
    expect(mock.captureStart).toHaveBeenCalledOnce();
    expect(mock.coreInstances).toBe(1);
  });
});
