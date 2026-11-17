import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CPU_PLANNER_MODEL, CPU_PLANNER_REVISION, CPU_PLANNER_INPUT_TOKENS } from "../src/shared/cpu-planner.js";
const mock = vi.hoisted(() => ({ pipeline: vi.fn(), generate: vi.fn(), tokenize: vi.fn(), cached: vi.fn() }));
vi.mock("../src/offscreen/provider-cache.js", () => ({ cachedProviderFiles: mock.cached }));
vi.mock("@huggingface/transformers", () => ({
  env: { backends: { onnx: { wasm: {} } } }, pipeline: mock.pipeline,
  TextStreamer: class { constructor(_tokenizer: unknown, public options: unknown) {} },
  InterruptableStoppingCriteria: class { interrupted = false; interrupt() { this.interrupted = true; } reset() { this.interrupted = false; } },
  StoppingCriteriaList: class { criteria: unknown[] = []; push(item: unknown) { this.criteria.push(item); } },
}));
let receive!: (event: { data: unknown }) => void;
let post: ReturnType<typeof vi.fn>;
const send = (data: unknown) => receive({ data });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const generate = () => send({ type: "generate", requestId: "request", messages: [{ role: "user", content: "Find backpacks" }], grammar: '{"type":"object"}' });
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  post = vi.fn(); vi.stubGlobal("self", { postMessage: post, addEventListener: (_: string, handler: typeof receive) => { receive = handler; } });
  mock.tokenize.mockReturnValue([1, 2, 3]);
  mock.cached.mockResolvedValue(new Set());
  mock.generate.mockResolvedValue([{ generated_text: '"ask","message":"Which size?"}' }]);
  Object.assign(mock.generate, { tokenizer: { apply_chat_template: () => "assistant\n", encode: mock.tokenize } });
  mock.pipeline.mockResolvedValue(mock.generate);
  await import("../src/offscreen/llm/cpu-worker.js");
  send({ type: "load", modelId: CPU_PLANNER_MODEL }); await settle();
});
afterEach(() => vi.unstubAllGlobals());
it("pins the CPU model and forces WASM q8; repeated load reuses the pipeline", async () => {
  expect(mock.pipeline).toHaveBeenCalledWith("text-generation", CPU_PLANNER_MODEL, expect.objectContaining({ device: "wasm", dtype: "q8", revision: CPU_PLANNER_REVISION }));
  send({ type: "load", modelId: CPU_PLANNER_MODEL }); await settle();
  expect(mock.pipeline).toHaveBeenCalledOnce();
  generate(); await settle();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "result", requestId: "request", text: '{"tool":"ask","message":"Which size?"}' }));
});
it("rejects oversized token context without silently truncating the task", async () => {
  mock.tokenize.mockReturnValue(Array(CPU_PLANNER_INPUT_TOKENS + 1).fill(1));
  generate(); await settle();
  expect(mock.generate).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: expect.stringContaining("more context") }));
});
it("starts inside the JSON response and stops after one complete object", async () => {
  Object.assign(mock.generate.tokenizer, { decode: () => '"ask","message":"Which size?"}' });
  mock.generate.mockImplementation(async (prompt, options) => {
    expect(prompt.endsWith('{"tool":')).toBe(true);
    options.streamer.options.token_callback_function([1n]);
    expect(options.stopping_criteria.criteria[0].interrupted).toBe(true);
    return [{ generated_text: '"ask","message":"Which size?"}' }];
  });
  generate(); await settle();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "result", text: '{"tool":"ask","message":"Which size?"}' }));
});
it("rejects truncated or non-JSON output and never reports a partial decision", async () => {
  mock.generate.mockResolvedValue([{ generated_text: '{"tool":"act"' }]);
  generate(); await settle();
  expect(post.mock.calls.some(([value]) => value.type === "result")).toBe(false);
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: expect.stringContaining("complete JSON") }));
});
it("rejects overlapping work and suppresses a result after cancellation", async () => {
  let release!: (value: unknown) => void;
  mock.generate.mockReturnValue(new Promise(resolve => { release = resolve; }));
  generate(); await settle();
  send({ type: "generate", requestId: "second", messages: [] });
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "error", requestId: "second", message: expect.stringContaining("busy") }));
  send({ type: "abort", requestId: "request" });
  release([{ generated_text: '{"tool":"ask","message":"Which size?"}' }]); await settle();
  expect(post.mock.calls.some(([value]) => value.type === "result")).toBe(false);
  expect(post).toHaveBeenCalledWith({ type: "cancelled", requestId: "request" });
});
it("keeps download percentages monotonic and only announces readiness after initialization", () => {
  const progress = mock.pipeline.mock.calls[0]![2].progress_callback;
  post.mockClear();
  for (const loaded of [80, 10, 90]) progress({ status: "progress", file: "onnx/model_quantized.onnx", loaded, total: 100 });
  expect(post.mock.calls.map(([value]) => value.loaded)).toEqual([80, 80, 90]);
  expect(post.mock.calls.some(([value]) => value.type === "ready")).toBe(false);
});
it("labels cached weight reads as preparation, even if the provider emits download progress", async () => {
  vi.resetModules(); mock.cached.mockResolvedValue(new Set(["onnx/model_quantized.onnx"]));
  await import("../src/offscreen/llm/cpu-worker.js");
  send({ type: "load", modelId: CPU_PLANNER_MODEL }); await settle();
  const progress = mock.pipeline.mock.calls.at(-1)![2].progress_callback; post.mockClear();
  progress({ status: "progress", file: "onnx/model_quantized.onnx", loaded: 50, total: 100 });
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ downloading: false, loaded: 50 }));
});
