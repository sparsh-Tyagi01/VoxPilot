/** GPU-independent text generation. Runs in a disposable, single-thread WASM worker. */
import { env, pipeline, TextStreamer, InterruptableStoppingCriteria, StoppingCriteriaList, type TextGenerationPipeline, type TextGenerationConfig, type ProgressInfo } from "@huggingface/transformers";
import { CPU_PLANNER_MODEL, CPU_PLANNER_REVISION, CPU_PLANNER_INPUT_TOKENS, CPU_PLANNER_OUTPUT_TOKENS } from "@shared/cpu-planner.js";
import type { ChatMessage, TokenUsage } from "./llm-worker.js";
import { cachedProviderFiles } from "../provider-cache.js";

if (env.backends.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.wasmPaths = {
    wasm: new URL("../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm", import.meta.url).href,
    mjs: new URL("../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs", import.meta.url).href,
  };
}
env.allowLocalModels = false;
env.useBrowserCache = true;

type Input = { type: "load"; modelId: string } | { type: "generate"; requestId: string; messages: ChatMessage[]; grammar?: string } | { type: "abort"; requestId: string };
type Output = { type: "ready" } | { type: "cancelled"; requestId: string }
  | { type: "progress"; loaded: number; total: number; downloading: boolean; text: string }
  | { type: "token"; requestId: string; delta: string }
  | { type: "result"; requestId: string; text: string; usage: TokenUsage }
  | { type: "error"; requestId: string; message: string };
let model: TextGenerationPipeline | null = null;
let busy = false;
let active: string | null = null;
let aborted = false;
const stop = new InterruptableStoppingCriteria();
const criteria = new StoppingCriteriaList(); criteria.push(stop);
const post = (value: Output) => self.postMessage(value);

async function load(modelId: string): Promise<void> {
  if (modelId !== CPU_PLANNER_MODEL) throw new Error("Unsupported CPU planner model.");
  if (model) return;
  let fraction = 0;
  post({ type: "progress", loaded: 0, total: 100, downloading: false, text: "Opening cached CPU planner…" });
  const cached = await cachedProviderFiles(modelId, CPU_PLANNER_REVISION, env.remoteHost, env.remotePathTemplate);
  const createTextPipeline = pipeline<"text-generation">;
  model = await createTextPipeline("text-generation", CPU_PLANNER_MODEL, {
    revision: CPU_PLANNER_REVISION, device: "wasm", dtype: "q8",
    progress_callback: (event: ProgressInfo) => {
      const info = event as { status: string; file?: string; loaded?: number; total?: number };
      if (!info.file?.endsWith(".onnx")) return;
      const next = info.status === "done" ? 0.99 : info.total ? Math.min(0.99, (info.loaded ?? 0) / info.total) : fraction;
      fraction = Math.max(fraction, next);
      const downloading = !cached.has(info.file) && ["download", "downloading", "progress"].includes(info.status);
      post({ type: "progress", loaded: fraction * 100, total: 100, downloading, text: downloading ? "Downloading CPU planner…" : "Preparing CPU planner (no GPU)…" });
    },
  });
}

async function generate(message: Extract<Input, { type: "generate" }>): Promise<void> {
  if (!model) throw new Error("The CPU planner is not loaded.");
  if (!Array.isArray(message.messages) || message.messages.length < 1 || message.messages.length > 8 || message.messages.some(item => !["system", "user", "assistant"].includes(item.role) || typeof item.content !== "string") || JSON.stringify(message.messages).length > 24_000) throw new Error("The CPU planner request exceeds its input limits.");
  if (message.grammar) JSON.parse(message.grammar); // Validation stays outside model inference.
  // Prefill the assistant's JSON prefix rather than hoping the small model chooses
  // JSON syntax. The continuation is still validated; this is not a grammar guarantee.
  const jsonPrefix = '{"tool":';
  const template = model.tokenizer.apply_chat_template(message.messages, { tokenize: false, add_generation_prompt: true });
  if (typeof template !== "string") throw new Error("The CPU chat template returned an unsupported input shape.");
  const prompt = template + jsonPrefix;
  const encoded = model.tokenizer.encode(prompt, { add_special_tokens: false });
  if (!Array.isArray(encoded) || encoded.some(token => typeof token !== "number")) throw new Error("The CPU tokenizer returned an unsupported input shape.");
  if (encoded.length > CPU_PLANNER_INPUT_TOKENS) throw new Error("This page needs more context than the CPU planner supports. Try a narrower task or an optional larger planner.");
  let generatedTokens = 0;
  const generatedIds: bigint[] = [];
  const streamer = new TextStreamer(model.tokenizer, {
    skip_prompt: true,
    token_callback_function: tokens => {
      generatedTokens += tokens.length; generatedIds.push(...tokens);
      const candidate = jsonPrefix + model!.tokenizer.decode(generatedIds, { skip_special_tokens: true });
      if (candidate.trimEnd().endsWith("}")) {
        try { JSON.parse(candidate); stop.interrupt(); } catch { /* The root object is not complete yet. */ }
      }
    },
    callback_function: delta => { if (!aborted && delta) post({ type: "token", requestId: message.requestId, delta }); },
  });
  const options: Partial<TextGenerationConfig> & { stopping_criteria: StoppingCriteriaList } = { max_new_tokens: CPU_PLANNER_OUTPUT_TOKENS, do_sample: false, add_special_tokens: false, return_full_text: false, streamer, stopping_criteria: criteria };
  const output = await model(prompt, options);
  if (aborted) return;
  const first = Array.isArray(output[0]) ? output[0][0] : output[0];
  const generated = first?.generated_text;
  const continuation = (typeof generated === "string" ? generated : generated?.filter(item => item.role === "assistant").at(-1)?.content ?? "").trim();
  if (!continuation) throw new Error("The CPU planner returned no decision.");
  const text = jsonPrefix + continuation;
  // Unlike WebLLM, this backend does not promise grammar-constrained decoding.
  // Reject non-JSON/truncation; the coordinator then enforces the full decision schema.
  try { JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()); }
  catch { throw new Error("The CPU planner did not produce a complete JSON decision. That decision was rejected."); }
  post({ type: "result", requestId: message.requestId, text, usage: { prompt_tokens: encoded.length, completion_tokens: generatedTokens, total_tokens: encoded.length + generatedTokens } });
}

self.addEventListener("message", (event: MessageEvent<Input>) => {
  const message = event.data;
  if (message.type === "abort") { if (active === message.requestId) { aborted = true; stop.interrupt(); } return; }
  if (busy) { post({ type: "error", requestId: message.type === "generate" ? message.requestId : "", message: "The CPU planner is busy." }); return; }
  busy = true; aborted = false; stop.reset(); active = message.type === "generate" ? message.requestId : null;
  void (async () => {
    try {
      if (message.type === "load") { await load(message.modelId); post({ type: "ready" }); }
      else await generate(message);
    } catch (error) {
      if (!aborted) post({ type: "error", requestId: message.type === "generate" ? message.requestId : "", message: error instanceof Error ? error.message : "CPU inference failed." });
    } finally {
      busy = false; active = null;
      if (aborted && message.type === "generate") post({ type: "cancelled", requestId: message.requestId });
    }
  })();
});
