/** WebLLM worker. One engine operation at a time; aborts bypass the queue. */
import { gpuFailureCode, type GPUFailureCode } from "./gpu-errors.js";
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
  | { type: "cancelled"; requestId: string; retired?: boolean }
  | { type: "progress"; loaded: number; total: number; text: string; downloading?: boolean }
  | { type: "token"; requestId: string; delta: string }
  | { type: "result"; requestId: string; text: string; usage: TokenUsage }
  | { type: "error"; requestId: string; message: string; code?: GPUFailureCode; stack?: string };


let engine: webllm.MLCEngine | null = null;
let currentModelId = "";
let busy = false;
let activeRequest: string | null = null;
let cancelledRequest: string | null = null;
let aborted = false;
let invalidated: GPUFailureCode | null = null;

function post(msg: LLMWorkerOutput): void { self.postMessage(msg); }
function postError(requestId: string, err: unknown): void {
  post({ type: "error", requestId, message: err instanceof Error ? err.message : String(err) });
}

function retireEngine(error: unknown, requestId = activeRequest ?? cancelledRequest ?? ""): void {
  const code = gpuFailureCode(error);
  if (!code || invalidated) return;
  invalidated = code;
  // Do not unmap/destroy again or wait for GPU sync on an invalid native engine.
  // Only the owner terminates this worker; no failed command is replayed here.
  engine = null;
  if (aborted && code === "GPU_BUFFER_INVALIDATED" && requestId) {
    post({ type: "cancelled", requestId, retired: true });
  } else {
    post({ type: "error", requestId, code, message: error instanceof Error ? error.message : String(error) });
  }
}

// Native GPU readback promises can reject outside the generation promise. Retire
// once and silence only this recognized failure; unrelated rejections stay visible.
self.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  if (!gpuFailureCode(event.reason)) return;
  event.preventDefault();
  retireEngine(event.reason);
});

async function unload(): Promise<void> {
  const previous = engine;
  engine = null;
  if (previous) {
    try { await previous.unload(); }
    catch (err) {
      if (gpuFailureCode(err)) retireEngine(err);
      else console.warn("[LLM Worker] Engine cleanup failed:", err);
    }
  }
}

async function loadEngine(modelId: string): Promise<void> {
  if (engine && currentModelId === modelId) return;
  await unload();
  if (invalidated) return;
  currentModelId = modelId;
  // Bound KV-cache memory. Prefill batch size is compiled into the model library.
  const appConfig = {
    ...webllm.prebuiltAppConfig,
    model_list: webllm.prebuiltAppConfig.model_list.map(record => ({
      ...record,
      overrides: { ...record.overrides, context_window_size: 4096 },
    })),
  };
  const loaded = await webllm.CreateMLCEngine(modelId, {
    appConfig,
    logLevel: "WARN",
    initProgressCallback: report => post({
      type: "progress", loaded: report.progress * 100, total: 100, text: report.text,
      downloading: /download|fetch/i.test(report.text) && !/cache/i.test(report.text),
    }),
  }, { context_window_size: 4096 });
  if (!invalidated) engine = loaded;
}

async function generate(msg: Extract<LLMWorkerInput, { type: "generate" }>): Promise<void> {
  if (!engine) {
    if (!currentModelId) throw new Error("AI planner is not loaded. Load a model first.");
    await loadEngine(currentModelId);
  }
  if (aborted || invalidated) return;
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
    if (aborted || invalidated) break;
    const delta = chunk.choices[0]?.delta?.content ?? "";
    finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
    if (delta) {
      fullText += delta;
      post({ type: "token", requestId: msg.requestId, delta });
    }
    if (chunk.usage) usage = chunk.usage;
  }
  if (aborted || invalidated) return;
  if (finishReason === "length") throw new Error("Plan exceeded output limit. Try a shorter command.");
  if (!fullText.trim()) throw new Error("AI planner returned an empty plan. Please try again.");
  post({ type: "result", requestId: msg.requestId, text: fullText, usage });
}

self.addEventListener("message", (event: MessageEvent<LLMWorkerInput>) => {
  const msg = event.data;
  if (msg.type === "abort") {
    if (activeRequest === msg.requestId) {
      aborted = true;
      cancelledRequest = msg.requestId;
      // Checking a flag between tokens alone does not stop WebGPU inference.
      const failed = (err: unknown) => {
        if (gpuFailureCode(err)) retireEngine(err);
        else console.warn("[LLM Worker] Interrupt failed:", err);
      };
      try { void Promise.resolve(engine?.interruptGenerate()).catch(failed); }
      catch (err) { failed(err); }
    }
    return;
  }
  if (invalidated) {
    post({ type: "error", requestId: msg.type === "generate" ? msg.requestId : "", code: invalidated, message: "The GPU engine is unavailable; this worker must be replaced." });
    return;
  }
  if (busy) {
    postError(msg.type === "generate" ? msg.requestId : "", new Error("AI planner is busy. Please retry after the current operation."));
    return;
  }
  busy = true;
  aborted = false;
  cancelledRequest = null;
  activeRequest = msg.type === "generate" ? msg.requestId : null;
  void (async () => {
    try {
      if (msg.type === "load") {
        await loadEngine(msg.modelId);
        if (!invalidated) post({ type: "ready" });
      } else {
        await generate(msg);
      }
    } catch (err) {
      if (gpuFailureCode(err)) {
        retireEngine(err, msg.type === "generate" ? msg.requestId : "");
      } else if (!invalidated) {
        await unload();
        if (!aborted && !invalidated) postError(msg.type === "generate" ? msg.requestId : "", err);
      }
    } finally {
      activeRequest = null;
      busy = false;
      if (aborted && !invalidated && msg.type === "generate") post({ type: "cancelled", requestId: msg.requestId });
    }
  })();
});
