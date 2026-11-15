import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProfile, downloadModels } from "../src/onboarding/model-download.js";

let listeners: Set<(value: unknown) => boolean>;
let sendMessage: ReturnType<typeof vi.fn>;
const emit = (value: unknown) => listeners.forEach(listener => listener(value));
const progress = (value: number, extra: Record<string, unknown> = {}) => ({
  type: "MODEL_LOAD_PROGRESS", profile: "essential", phase: "downloading", progress: value, ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  listeners = new Set();
  sendMessage = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("chrome", { runtime: {
    sendMessage,
    onMessage: { addListener: (listener: (value: unknown) => boolean) => listeners.add(listener), removeListener: (listener: (value: unknown) => boolean) => listeners.delete(listener) },
  } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("onboarding model setup", () => {
  it("subscribes before cached models can finish synchronously with the start request", async () => {
    const render = vi.fn();
    sendMessage.mockImplementation(async () => {
      emit(progress(1, { done: true, phase: "ready" }));
      return { ok: true };
    });
    await downloadModels("lite", render);
    expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ percent: 100 }));
    expect(listeners.size).toBe(0);
  });

  it("restores matching cached readiness using GET_MODEL_STATUS", async () => {
    sendMessage.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(progress(1, { done: true, phase: "ready" }));
    await downloadModels("lite", vi.fn());
    expect(sendMessage).toHaveBeenLastCalledWith({ type: "GET_MODEL_STATUS" });
    expect(listeners.size).toBe(0);
  });

  it("keeps displayed progress monotonic, ignores another profile, and requires real readiness", async () => {
    const render = vi.fn();
    const result = downloadModels("lite", render);
    await Promise.resolve();
    emit(progress(0.6));
    emit(progress(0.2));
    emit(progress(1, { profile: "powerful", done: true }));
    expect(render.mock.calls.map(([value]) => value.percent)).toEqual([60, 60]);
    expect(listeners.size).toBe(1);
    emit(progress(1, { phase: "ready", done: true }));
    await result;
    expect(listeners.size).toBe(0);
  });

  it("removes the listener when setup is rejected so retry cannot leak callbacks", async () => {
    sendMessage.mockResolvedValueOnce({ ok: false, error: "Offline" });
    await expect(downloadModels("lite", vi.fn())).rejects.toThrow("Offline");
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up on model failure and page closure", async () => {
    const abort = new AbortController();
    const first = downloadModels("lite", vi.fn(), { signal: abort.signal });
    const firstAssertion = expect(first).rejects.toThrow("cancelled");
    abort.abort();
    await firstAssertion;
    expect(listeners.size).toBe(0);
    const second = downloadModels("lite", vi.fn());
    const secondAssertion = expect(second).rejects.toThrow("GPU unavailable");
    emit(progress(0, { phase: "error", text: "GPU unavailable" }));
    await secondAssertion;
    expect(listeners.size).toBe(0);
  });

  it("removes its listener and deadline when setup stalls", async () => {
    const result = downloadModels("lite", vi.fn(), { timeoutMs: 100 });
    const assertion = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not invent a download percentage while cached models initialize", async () => {
    const render = vi.fn();
    const result = downloadModels("lite", render);
    emit(progress(0.4, { phase: "loading" }));
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ determinate: false }));
    emit(progress(1, { phase: "ready", done: true }));
    await result;
    expect(canonicalProfile("standard")).toBe("balanced");
  });
});
