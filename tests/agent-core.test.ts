import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GPU_RECOVERY_MODEL, GPU_RECOVERY_DELAY_MS, GPU_RECOVERY_LOAD_TIMEOUT_MS } from "../src/offscreen/llm/gpu-errors.js";
import { AgentState, ModelProfile } from "../src/shared/types.js";
import type { TTS } from "../src/offscreen/audio/tts.js";

const { sendToSW } = vi.hoisted(() => ({ sendToSW: vi.fn(async () => undefined) }));
vi.mock("../src/offscreen/offscreen.js", () => ({ sendToSW }));
import { AgentCore } from "../src/offscreen/agent/agent-core.js";

class FakeWorker {
  static instances: FakeWorker[] = [];
  listeners = new Map<string, (event: { data?: unknown; message?: string }) => void>();
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(public url: URL) { FakeWorker.instances.push(this); }
  addEventListener(type: string, cb: (event: { data?: unknown; message?: string }) => void) { this.listeners.set(type, cb); }
  emit(data: unknown) { this.listeners.get("message")?.({ data }); }
}

describe("Agent worker recovery", () => {
  let core: AgentCore;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sendToSW.mockImplementation(async () => undefined);
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    core = new AgentCore({ tts: { stop: vi.fn(), isSpeaking: false } as unknown as TTS, siteAware: false });
    await core.initialize(ModelProfile.Fast, true);
    FakeWorker.instances.forEach(worker => worker.emit({ type: "ready" }));
    await Promise.resolve();
    core.resumeListening();
  });
  afterEach(() => { core.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("restarts timed-out STT and ignores messages from the terminated worker", async () => {
    const oldWorker = FakeWorker.instances[0]!;
    core.onSpeechStart();
    const request = core.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(60_000);
    await request;
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    expect(FakeWorker.instances).toHaveLength(3);
    oldWorker.emit({ type: "result", text: "scroll down", confidence: 1, language: "en" });
    expect(sendToSW.mock.calls.some(([msg]) => (msg as { type?: string })?.type === "PLAN_PRODUCED")).toBe(false);
  });

  it("stops transcription without executing a late result", async () => {
    const oldWorker = FakeWorker.instances[0]!;
    core.onSpeechStart();
    const request = core.onSpeechEnd(new Float32Array(16000));
    await Promise.resolve();
    core.triggerKill();
    oldWorker.emit({ type: "result", text: "scroll down", confidence: 1, language: "en" });
    await request;
    expect(core.currentState).toBe(AgentState.Listening);
    expect(sendToSW.mock.calls.some(([msg]) => (msg as { type?: string })?.type === "PLAN_PRODUCED")).toBe(false);
  });

  it("recreates an LLM worker that fails to acknowledge cancellation", async () => {
    const llm = FakeWorker.instances[1]!;
    const request = core.executeCommandText("summarize the details on this page");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(llm.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "generate" }));
    await vi.advanceTimersByTimeAsync(60_000);
    await request;
    expect(llm.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "abort" }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(llm.terminate).toHaveBeenCalledOnce();
    expect(FakeWorker.instances).toHaveLength(3);
  });

  it("keeps a healthy LLM worker when cancellation is acknowledged", async () => {
    const llm = FakeWorker.instances[1]!;
    const request = core.executeCommandText("summarize the details on this page");
    await vi.advanceTimersByTimeAsync(3_000);
    const generate = llm.postMessage.mock.calls.find(([msg]) => msg.type === "generate")![0];
    core.triggerKill();
    llm.emit({ type: "cancelled", requestId: generate.requestId });
    await request;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(llm.terminate).not.toHaveBeenCalled();
    expect(core.currentState).toBe(AgentState.Listening);
  });

  it("reuses initialized workers on repeated initialization and pause/resume", async () => {
    const oldWorkers = [...FakeWorker.instances];
    core.pauseListening();
    await core.initialize(ModelProfile.Fast, true);
    core.resumeListening();
    expect(FakeWorker.instances).toHaveLength(2);
    expect(oldWorkers.every(worker => worker.terminate.mock.calls.length === 0)).toBe(true);
    expect(core.currentState).toBe(AgentState.Listening);
  });

  it("accepts only one speech end while recognition is pending", async () => {
    const stt = FakeWorker.instances[0]!;
    core.onSpeechStart();
    const first = core.onSpeechEnd(new Float32Array(16000));
    const second = core.onSpeechEnd(new Float32Array(16000));
    await Promise.resolve();
    core.onExecutionDone(); // A late execution message must not reopen speech capture.
    core.onSpeechStart();
    expect(core.currentState).toBe(AgentState.Transcribing);
    expect(stt.postMessage.mock.calls.filter(([msg]) => msg.type === "transcribe")).toHaveLength(1);
    stt.emit({ type: "result", text: "", confidence: 1, language: "en" });
    await Promise.all([first, second]);
    expect(core.currentState).toBe(AgentState.Listening);
  });

  it("grounds fast click commands and does not overwrite synchronous completion", async () => {
    const request = core.executeCommandText("click login");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await core.onPageSnapshot({ url: "https://example.com", title: "test", capturedAt: Date.now(), truncated: false,
      elements: [{ handle: "e1", tag: "button", label: "Login", inViewport: true }] });
    sendToSW.mockImplementation(async msg => {
      if ((msg as { type?: string }).type === "PLAN_PRODUCED") core.onExecutionDone();
    });
    await request;
    const call = sendToSW.mock.calls.find(([msg]) => (msg as { type?: string }).type === "PLAN_PRODUCED");
    expect((call?.[0] as { plan: { actions: { handle?: string }[] } }).plan.actions[0]!.handle).toBe("e1");
    expect(core.currentState).toBe(AgentState.Listening);
  });
  it("delegates arbitrary goals and search to site tasks in the shipped default mode", async () => {
    core.dispose(); FakeWorker.instances = [];
    core = new AgentCore({ tts: { stop: vi.fn(), isSpeaking: false } as unknown as TTS });
    await core.initialize(ModelProfile.Fast);
    FakeWorker.instances[0]!.emit({ type: "ready" }); core.resumeListening();
    sendToSW.mockClear();
    await core.executeCommandText("Could you find a waterproof backpack under £80?");
    await core.executeCommandText("search for backpacks");
    expect(sendToSW).toHaveBeenCalledWith({ type: "START_SITE_TASK", goal: "Could you find a waterproof backpack under £80?" });
    expect(sendToSW).toHaveBeenCalledWith({ type: "START_SITE_TASK", goal: "search for backpacks" });
    expect(sendToSW.mock.calls.some(([message]) => (message as { type: string }).type === "PLAN_PRODUCED")).toBe(false);
  });
  it("uses recognized speech to answer only the active clarification, never to approve a mutation", async () => {
    core.onSiteTaskState({ version: 1, id: "site-task", tabId: 12, origin: "https://example.com", goal: "Add this shirt", status: "awaiting_answer", steps: 0, message: "Which size?" });
    core.onSpeechStart(); const speech = core.onSpeechEnd(new Float32Array(16000)); await Promise.resolve();
    FakeWorker.instances[0]!.emit({ type: "result", text: "Medium", confidence: null, language: "en" });
    await speech;
    expect(sendToSW).toHaveBeenCalledWith({ type: "SITE_TASK_REPLY", taskId: "site-task", answer: "Medium" });
  });

  it("keeps model progress monotonic across files and reports the active profile", async () => {
    await core.initialize(ModelProfile.Balanced, true);
    sendToSW.mockClear();
    const stt = FakeWorker.instances[2]!;
    const llm = FakeWorker.instances[3]!;
    stt.emit({ type: "progress", loaded: 80, total: 100, modelId: "test", downloading: true });
    stt.emit({ type: "progress", loaded: 10, total: 100, modelId: "test", downloading: true });
    llm.emit({ type: "progress", loaded: 40, total: 100, text: "fetching", downloading: true });
    llm.emit({ type: "progress", loaded: 20, total: 100, text: "fetching", downloading: true });
    const progress = sendToSW.mock.calls.map(([msg]) => msg as { type?: string; progress?: number; profile?: string; phase?: string }).filter(msg => msg.type === "MODEL_LOAD_PROGRESS");
    expect(progress.every((msg, i) => i === 0 || msg.progress! >= progress[i - 1]!.progress!)).toBe(true);
    expect(progress.at(-1)?.profile).toBe("balanced");
    expect(progress.at(-1)?.phase).toBe("downloading");
    expect(progress.at(-1)?.progress).toBeCloseTo(0.46);
  });
  it("loads the CPU worker without WebLLM and retains it across microphone pauses", async () => {
    await core.initialize(ModelProfile.Cpu, true);
    const cpu = FakeWorker.instances.at(-1)!;
    expect(cpu.url.pathname).toMatch(/cpu-worker\.ts$/);
    FakeWorker.instances.at(-2)!.emit({ type: "ready" }); cpu.emit({ type: "ready" });
    core.resumeListening(); core.pauseListening();
    const count = FakeWorker.instances.length;
    await core.initialize(ModelProfile.Cpu);
    expect(FakeWorker.instances).toHaveLength(count);
    expect(cpu.terminate).not.toHaveBeenCalled();
  });
  it("CPU setup cannot announce completion after only the speech worker is ready", async () => {
    const setup = core.loadProfile(ModelProfile.Cpu);
    await Promise.resolve();
    const speech = FakeWorker.instances.at(-2)!; const cpu = FakeWorker.instances.at(-1)!;
    speech.emit({ type: "ready" }); await Promise.resolve();
    expect(sendToSW.mock.calls.map(([value]) => value as { type: string; done?: boolean }).filter(value => value.type === "MODEL_LOAD_PROGRESS").at(-1)?.done).toBe(false);
    cpu.emit({ type: "ready" }); await setup;
  });
  it("permits the initial CPU setup download to exceed the on-demand planner timeout", async () => {
    let complete = false;
    const setup = core.loadProfile(ModelProfile.Cpu).then(() => { complete = true; });
    await Promise.resolve();
    const speech = FakeWorker.instances.at(-2)!; const cpu = FakeWorker.instances.at(-1)!;
    speech.emit({ type: "ready" }); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(GPU_RECOVERY_LOAD_TIMEOUT_MS + 1);
    expect(complete).toBe(false);
    cpu.emit({ type: "ready" }); await setup;
    expect(complete).toBe(true);
  });
  it("hard-stops CPU inference without the GPU auto-reload timer or accepting late output", async () => {
    await core.initialize(ModelProfile.Cpu, true);
    FakeWorker.instances.at(-2)!.emit({ type: "ready" });
    const cpu = FakeWorker.instances.at(-1)!; cpu.emit({ type: "ready" }); core.resumeListening();
    const pending = core.executeCommandText("summarize the details on this page");
    await vi.advanceTimersByTimeAsync(3000);
    const generation = cpu.postMessage.mock.calls.find(([message]) => message.type === "generate")![0];
    const count = FakeWorker.instances.length;
    core.triggerKill(); await pending;
    cpu.emit({ type: "result", requestId: generation.requestId, text: '{}', usage: { completion_tokens: 1 } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(cpu.terminate).toHaveBeenCalledOnce();
    expect(FakeWorker.instances).toHaveLength(count);
    expect(core.currentState).toBe(AgentState.Listening);
  });
  it("does not begin site inference after cancellation during a cold CPU model load", async () => {
    await core.initialize(ModelProfile.Cpu);
    FakeWorker.instances.at(-1)!.emit({ type: "ready" });
    const state = { version: 1 as const, id: "cold-task", tabId: 12, origin: "https://example.com", goal: "Find a product", status: "planning" as const, steps: 0, message: "Planning" };
    core.onSiteTaskState(state);
    const pending = core.decideSiteTask({ taskId: state.id, goal: state.goal, answers: [], history: [], remainingMs: 120_000,
      observation: { documentId: "doc", observationId: "obs", stateKey: "state", url: state.origin, title: "Store", capturedAt: 1, truncated: false, elements: [], forms: [], coverage: { candidates: 0, inspected: 0, limited: false, frames: "top_only" } } });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    const cpu = FakeWorker.instances.at(-1)!;
    core.onSiteTaskState({ ...state, status: "cancelled" });
    cpu.emit({ type: "ready" }); await rejected;
    expect(cpu.postMessage.mock.calls.some(([message]) => message.type === "generate")).toBe(false);
  });

  it("retries a failed load instead of reusing rejected readiness promises", async () => {
    await core.initialize(ModelProfile.Balanced, true);
    FakeWorker.instances[3]!.emit({ type: "error", requestId: "", message: "download interrupted" });
    await core.initialize(ModelProfile.Balanced, true);
    expect(FakeWorker.instances).toHaveLength(6);
    expect(FakeWorker.instances[3]!.terminate).toHaveBeenCalledOnce();
  });

  it("accepts voice stop while planning a previous voice command", async () => {
    const stt = FakeWorker.instances[0]!;
    const llm = FakeWorker.instances[1]!;
    core.onSpeechStart();
    const planning = core.onSpeechEnd(new Float32Array(16000));
    await Promise.resolve();
    stt.emit({ type: "result", text: "summarize the details on this page", confidence: 1, language: "en" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(llm.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "generate" }));
    core.onSpeechStart();
    const stopping = core.onSpeechEnd(new Float32Array(16000));
    await Promise.resolve();
    expect(stt.postMessage.mock.calls.filter(([msg]) => msg.type === "transcribe")).toHaveLength(2);
    stt.emit({ type: "result", text: "stop", confidence: 1, language: "en" });
    await Promise.all([planning, stopping]);
    expect(llm.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "abort" }));
    expect(core.currentState).toBe(AgentState.Listening);
  });

  it("accepts voice stop during planning without starting another command", async () => {
    const stt = FakeWorker.instances[0]!;
    const llm = FakeWorker.instances[1]!;
    const planning = core.executeCommandText("summarize the details on this page");
    await vi.advanceTimersByTimeAsync(3_000);
    core.onSpeechStart();
    const utterance = core.onSpeechEnd(new Float32Array(16000));
    await Promise.resolve();
    stt.emit({ type: "result", text: "stop", confidence: 1, language: "en" });
    await Promise.all([planning, utterance]);
    expect(llm.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "abort" }));
    expect(core.currentState).toBe(AgentState.Listening);
  });

  it("terminates previous workers before switching model profiles", async () => {
    const oldWorkers = [...FakeWorker.instances];
    await core.initialize(ModelProfile.Balanced, true);
    expect(oldWorkers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
    expect(FakeWorker.instances).toHaveLength(4);
  });
  it.each([
    ["GPU_DEVICE_LOST", "[Device] is lost."],
    ["GPU_BUFFER_INVALIDATED", "Failed to execute 'mapAsync' on 'GPUBuffer': Buffer was unmapped before mapping was resolved."],
  ] as const)("replaces a worker after %s once, without replaying the command", async (code, message) => {
    const failed = FakeWorker.instances[1]!;
    const request = core.executeCommandText("summarize this page");
    await vi.advanceTimersByTimeAsync(3_000);
    const generate = failed.postMessage.mock.calls.find(([msg]) => msg.type === "generate")![0];
    failed.emit({ type: "error", requestId: generate.requestId, code, message });
    await request;
    expect(failed.terminate).toHaveBeenCalledOnce();
    expect(sendToSW.mock.calls.some(([msg]) => (msg as any).type === "MODEL_LOAD_PROGRESS" && (msg as any).done === false && /smaller/.test((msg as any).text))).toBe(true);
    core.pauseListening();
    await core.initialize(ModelProfile.Fast, true); // Resuming during the deferred recovery must keep the smaller model.
    core.resumeListening();
    expect(FakeWorker.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(GPU_RECOVERY_DELAY_MS);
    const recovered = FakeWorker.instances[2]!;
    expect(recovered.postMessage).toHaveBeenCalledWith({ type: "load", modelId: GPU_RECOVERY_MODEL });
    // Late results from the terminated worker never reach planning/execution.
    failed.emit({ type: "result", requestId: generate.requestId, text: '{"intent":"stale"}', usage: { completion_tokens: 1 } });
    recovered.emit({ type: "ready" });
    expect(recovered.postMessage.mock.calls.some(([msg]) => msg.type === "generate")).toBe(false);
    expect(sendToSW.mock.calls.some(([msg]) => (msg as any).type === "PLAN_PRODUCED")).toBe(false);
    // A second loss opens the circuit instead of allocating endlessly.
    recovered.emit({ type: "error", requestId: "", code: "GPU_DEVICE_LOST", message: "DeviceLostError" });
    await core.initialize(ModelProfile.Fast, true); // Ordinary mic restart must not reopen the circuit.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWorker.instances).toHaveLength(3);
    const stt = FakeWorker.instances[0]!;
    expect(stt.terminate).not.toHaveBeenCalled();
    expect(sendToSW.mock.calls.some(([msg]) => (msg as any).type === "MODEL_LOAD_PROGRESS" && (msg as any).phase === "error")).toBe(true);
  });
  it("routes a worker-level unmapped-buffer failure through bounded GPU recovery", async () => {
    const failed = FakeWorker.instances[1]!;
    failed.listeners.get("error")?.({ message: "Failed to execute 'mapAsync' on 'GPUBuffer': Buffer was unmapped before mapping was resolved." });
    expect(failed.terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(GPU_RECOVERY_DELAY_MS);
    expect(FakeWorker.instances[2]!.postMessage).toHaveBeenCalledWith({ type: "load", modelId: GPU_RECOVERY_MODEL });
    expect(FakeWorker.instances[0]!.terminate).not.toHaveBeenCalled();
  });
  it("retires a cancelled GPU worker without immediate reload or consuming failure recovery", async () => {
    const failed = FakeWorker.instances[1]!;
    const pending = core.executeCommandText("summarize this page");
    await vi.advanceTimersByTimeAsync(3_000);
    const request = failed.postMessage.mock.calls.find(([message]) => message.type === "generate")![0];
    core.triggerKill(); await pending;
    failed.emit({ type: "cancelled", requestId: request.requestId, retired: true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(failed.terminate).toHaveBeenCalledOnce();
    expect(FakeWorker.instances).toHaveLength(2);
    const ready = core.ensurePlannerReady();
    const next = FakeWorker.instances[2]!;
    expect(next.postMessage).toHaveBeenCalledWith(failed.postMessage.mock.calls[0]![0]);
    next.emit({ type: "ready" }); await ready;
    next.emit({ type: "error", requestId: "", code: "GPU_BUFFER_INVALIDATED", message: "Buffer read interrupted" });
    await vi.advanceTimersByTimeAsync(GPU_RECOVERY_DELAY_MS);
    expect(FakeWorker.instances).toHaveLength(4);
    expect(FakeWorker.instances[3]!.postMessage).toHaveBeenCalledWith({ type: "load", modelId: GPU_RECOVERY_MODEL });
  });
  it("fails an overlapping new request if a late cancellation retires its worker", async () => {
    const worker = FakeWorker.instances[1]!;
    const first = core.executeCommandText("summarize this page");
    await vi.advanceTimersByTimeAsync(3_000);
    const request = worker.postMessage.mock.calls.find(([message]) => message.type === "generate")![0];
    core.triggerKill(); await first;
    worker.emit({ type: "cancelled", requestId: request.requestId });
    const second = core.executeCommandText("summarize the details on this page");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(worker.postMessage.mock.calls.filter(([message]) => message.type === "generate")).toHaveLength(2);
    worker.emit({ type: "cancelled", requestId: request.requestId, retired: true });
    await second;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(sendToSW.mock.calls.some(([message]) => (message as { type: string }).type === "PLAN_PRODUCED")).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(core.currentState).toBe(AgentState.Listening);
  });

  it("keeps setup readiness pending until a replacement GPU model is ready", async () => {
    const loading = (async () => { await core.initialize(ModelProfile.Balanced, true); await core.ensurePlannerReady(); })();
    await Promise.resolve();
    const failed = FakeWorker.instances[3]!;
    FakeWorker.instances[2]!.emit({ type: "ready" });
    failed.emit({ type: "error", requestId: "", code: "GPU_DEVICE_LOST", message: "Device was lost during reload" });
    await vi.advanceTimersByTimeAsync(GPU_RECOVERY_DELAY_MS);
    FakeWorker.instances[4]!.emit({ type: "ready" });
    await expect(loading).resolves.toBeUndefined();
  });

  it("bounds recovery loading and preserves basic commands after repeated GPU loss", async () => {
    FakeWorker.instances[1]!.emit({ type: "error", requestId: "", code: "GPU_DEVICE_LOST", message: "Device lost" });
    await vi.advanceTimersByTimeAsync(GPU_RECOVERY_DELAY_MS + GPU_RECOVERY_LOAD_TIMEOUT_MS);
    expect(FakeWorker.instances[2]!.terminate).toHaveBeenCalledOnce();
    core.resumeListening();
    const request = core.executeCommandText("scroll down");
    await request;
    expect(sendToSW.mock.calls.some(([msg]) => (msg as any).type === "PLAN_PRODUCED")).toBe(true);
  });

  it("cancels deferred GPU recovery when the agent is disposed", async () => {
    FakeWorker.instances[1]!.emit({ type: "error", requestId: "", code: "GPU_DEVICE_LOST", message: "Device lost" });
    core.dispose();
    await vi.advanceTimersByTimeAsync(GPU_RECOVERY_DELAY_MS + 1);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it("initializes Essential speech without a GPU worker or a planner readiness dependency", async () => {
    core.dispose(); FakeWorker.instances = [];
    await core.initialize(ModelProfile.Essential);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.url.href).toContain("stt-worker");
    FakeWorker.instances[0]!.emit({ type: "ready" });
    await expect(core.loadProfile(ModelProfile.Essential)).resolves.toBeUndefined();
    core.resumeListening();
    await core.executeCommandText("scroll down");
    expect(FakeWorker.instances).toHaveLength(1);
    expect(sendToSW.mock.calls.some(([msg]) => (msg as any).type === "PLAN_PRODUCED")).toBe(true);
  });
  it("prepares Hosted assist speech without creating any local planner worker", async () => {
    core.dispose(); FakeWorker.instances = [];
    await core.initialize(ModelProfile.Hosted, true);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.url.href).toContain("stt-worker");
    FakeWorker.instances[0]!.emit({ type: "ready" });
    await expect(core.loadProfile(ModelProfile.Hosted)).resolves.toBeUndefined();
    expect(FakeWorker.instances).toHaveLength(1);
    await expect(core.ensurePlannerReady()).rejects.toThrow("no local planner");
    expect(sendToSW.mock.calls.some(([message]) => (message as { text?: string }).text === "Voice ready — hosted planning selected")).toBe(true);
  });

  it("does not load an AI model for an unresolved Essential request", async () => {
    core.dispose(); FakeWorker.instances = [];
    await core.initialize(ModelProfile.Essential);
    FakeWorker.instances[0]!.emit({ type: "ready" }); core.resumeListening();
    await core.executeCommandText("summarize the contents of this website");
    expect(FakeWorker.instances).toHaveLength(1);
    const plan = sendToSW.mock.calls.map(([msg]) => msg as any).find(msg => msg.type === "PLAN_PRODUCED");
    expect(plan).toBeUndefined();
    expect(sendToSW.mock.calls.some(([msg]) => (msg as any).type === "COMMAND_NOTICE")).toBe(true);
  });

  it("releases an idle planner and reloads it only on demand", async () => {
    const old = FakeWorker.instances[1]!;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(old.terminate).toHaveBeenCalledOnce();
    await core.initialize(ModelProfile.Fast);
    expect(FakeWorker.instances).toHaveLength(2);
    const ready = core.ensurePlannerReady();
    expect(FakeWorker.instances).toHaveLength(3);
    FakeWorker.instances[2]!.emit({ type: "ready" });
    await ready;
  });

  it("does not speak or plan repeated unknown voice transcripts in Essential mode", async () => {
    core.dispose(); FakeWorker.instances = [];
    await core.initialize(ModelProfile.Essential);
    const stt = FakeWorker.instances[0]!; stt.emit({ type: "ready" }); core.resumeListening();
    sendToSW.mockClear();
    for (let i = 0; i < 5; i++) {
      core.onSpeechStart();
      const request = core.onSpeechEnd(new Float32Array(16000)); await Promise.resolve();
      stt.emit({ type: "result", text: "Thank you for watching", confidence: null, language: "en" });
      await request;
    }
    expect(core.currentState).toBe(AgentState.Listening);
    expect(sendToSW.mock.calls.map(([msg]) => (msg as any).type)).not.toContain("PLAN_PRODUCED");
    expect(sendToSW.mock.calls.map(([msg]) => (msg as any).type)).not.toContain("COMMAND_NOTICE");
    expect(FakeWorker.instances).toHaveLength(1);
  });

});
