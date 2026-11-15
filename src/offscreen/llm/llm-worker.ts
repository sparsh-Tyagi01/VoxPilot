/** WebLLM worker. One engine operation at a time; aborts bypass the queue. */
import { isGPUDeviceLoss } from "./gpu-errors.js";
import * as webllm from "@mlc-ai/web-llm";
import { AGENT_PLAN_GENERATION_SCHEMA } from "@shared/schema.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Messages received from the main offscreen thread. */
type LLMWorkerInput =
  | { type: "load"; modelId: string }
  | { type: "generate"; messages: ChatMessage[]; grammar?: string; requestId: string }
  | { type: "abort"; requestId: string };

/** Messages sent to the main offscreen thread. */
type LLMWorkerOutput =
  | { type: "ready" }
  | { type: "cancelled"; requestId: string }
  | { type: "progress"; loaded: number; total: number; text: string; downloading?: boolean }
  | { type: "token"; requestId: string; delta: string }
  | { type: "result"; requestId: string; text: string; usage: TokenUsage }
  | { type: "error"; requestId: string; message: string; code?: "GPU_DEVICE_LOST"; stack?: string };


let engine: webllm.MLCEngine | null = null;
let currentModelId = "";
let busy = false;
let activeRequest: string | null = null;
let aborted = false;
let deviceLost = false;

function post(msg: LLMWorkerOutput): void { self.postMessage(msg); }
function postError(requestId: string, err: unknown): void {
  post({ type: "error", requestId, message: err instanceof Error ? err.message : String(err) });
}

async function unload(): Promise<void> {
  const previous = engine;
  engine = null;
  if (previous) {
    try { await previous.unload(); }
    catch (err) { console.warn("[LLM Worker] Engine cleanup failed:", err); }
  }
}

async function loadEngine(modelId: string): Promise<void> {
  if (engine && currentModelId === modelId) return;
  await unload();
  currentModelId = modelId;
  // Bound KV-cache memory. Prefill batch size is compiled into the model library.
  const appConfig = {
    ...webllm.prebuiltAppConfig,
    model_list: webllm.prebuiltAppConfig.model_list.map(record => ({
      ...record,
      overrides: { ...record.overrides, context_window_size: 4096 },
    })),
  };
  engine = await webllm.CreateMLCEngine(modelId, {
    appConfig,
    logLevel: "WARN",
    initProgressCallback: report => post({
      type: "progress", loaded: report.progress * 100, total: 100, text: report.text,
      downloading: /download|fetch/i.test(report.text) && !/cache/i.test(report.text),
    }),
  }, { context_window_size: 4096 });
}

async function generate(msg: Extract<LLMWorkerInput, { type: "generate" }>): Promise<void> {
  if (!engine) {
    if (!currentModelId) throw new Error("AI planner is not loaded. Load a model first.");
    await loadEngine(currentModelId);
  }
  if (aborted) return;
  // This WebLLM version passes schema straight to the native string binding.
  // Omitting it causes GrammarMatcherInitError and poisons subsequent requests.
  const schema = msg.grammar ?? JSON.stringify(AGENT_PLAN_GENERATION_SCHEMA);
  JSON.parse(schema); // Reject malformed input before touching native state.
  const stream = await engine!.chat.completions.create({
    messages: msg.messages,
    temperature: 0.1,
    top_p: 0.9,
    max_tokens: 384,
    stream: true,
    stream_options: { include_usage: true },
    response_format: { type: "json_object", schema },
  });
  let fullText = "";
  let usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let finishReason: string | null = null;
  for await (const chunk of stream) {
    if (aborted) break;
    const delta = chunk.choices[0]?.delta?.content ?? "";
    finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
    if (delta) {
      fullText += delta;
      post({ type: "token", requestId: msg.requestId, delta });
    }
    if (chunk.usage) usage = chunk.usage;
  }
  if (aborted) return;
  if (finishReason === "length") throw new Error("Plan exceeded output limit. Try a shorter command.");
  if (!fullText.trim()) throw new Error("AI planner returned an empty plan. Please try again.");
  post({ type: "result", requestId: msg.requestId, text: fullText, usage });
}

self.addEventListener("message", (event: MessageEvent<LLMWorkerInput>) => {
  const msg = event.data;
  if (msg.type === "abort") {
    if (activeRequest === msg.requestId) {
      aborted = true;
      // Checking a flag between tokens alone does not stop WebGPU inference.
      void engine?.interruptGenerate().catch(err => console.warn("[LLM Worker] Interrupt failed:", err));
    }
    return;
  }
  if (deviceLost) {
    post({ type: "error", requestId: msg.type === "generate" ? msg.requestId : "", code: "GPU_DEVICE_LOST", message: "The GPU device was lost; this worker must be replaced." });
    return;
  }
  if (busy) {
    postError(msg.type === "generate" ? msg.requestId : "", new Error("AI planner is busy. Please retry after the current operation."));
    return;
  }
  busy = true;
  aborted = false;
  activeRequest = msg.type === "generate" ? msg.requestId : null;
  void (async () => {
    try {
      if (msg.type === "load") {
        await loadEngine(msg.modelId);
        post({ type: "ready" });
      } else {
        await generate(msg);
      }
    } catch (err) {
      if (isGPUDeviceLoss(err)) {
        // WebLLM already unloads on device.lost. A second unload can race or hang
        // on GPU sync. Notify the owner immediately so it can terminate this realm.
        deviceLost = true;
        engine = null;
        post({ type: "error", requestId: msg.type === "generate" ? msg.requestId : "", code: "GPU_DEVICE_LOST", message: err instanceof Error ? err.message : String(err) });
      } else {
        await unload();
        if (!aborted) postError(msg.type === "generate" ? msg.requestId : "", err);
      }
    } finally {
      activeRequest = null;
      busy = false;
      if (aborted && msg.type === "generate") post({ type: "cancelled", requestId: msg.requestId });
    }
  })();
});
