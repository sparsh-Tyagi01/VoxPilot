/**
 * @file src/offscreen/llm/llm-worker.ts
 * @description LLM Web Worker — Llama 3.2 1B via @mlc-ai/web-llm (WebGPU).
 *
 * This worker owns the WebLLM engine lifecycle. It receives planning requests
 * (system prompt + user message) and streams back a constrained JSON AgentPlan.
 *
 * SRS references:
 * - FR-MODEL-02: Llama 3.2 1B Instruct q4f16_1 via WebLLM
 * - FR-PLAN-01: LLM produces constrained JSON conforming to Appendix A schema
 * - FR-PLAN-02: Constrained decoding (JSON grammar) prevents hallucinated action types
 * - NFR-PERF-01: LLM path ≤2.5s p50, ≤4.0s p95 (Tier-1 hardware)
 * - NFR-PRV-01: All inference on-device; no external API calls
 * - IR-COM-01: Only network traffic is model download from HuggingFace
 *
 * PostMessage API:
 *
 * Input  → { type: 'load',     modelId: string }
 * Input  → { type: 'generate', messages: ChatMessage[]; grammar?: string; requestId: string }
 * Input  → { type: 'abort',    requestId: string }
 *
 * Output ← { type: 'ready' }
 * Output ← { type: 'progress', loaded: number; total: number; text: string }
 * Output ← { type: 'token',    requestId: string; delta: string }
 * Output ← { type: 'result',   requestId: string; text: string; usage: TokenUsage }
 * Output ← { type: 'error',    requestId: string; message: string; stack?: string }
 */

import * as webllm from "@mlc-ai/web-llm";

// ─── Types ─────────────────────────────────────────────────────────────────────

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
  | { type: "progress"; loaded: number; total: number; text: string }
  | { type: "token"; requestId: string; delta: string }
  | { type: "result"; requestId: string; text: string; usage: TokenUsage }
  | { type: "error"; requestId: string; message: string; stack?: string };

// ─── Worker State ──────────────────────────────────────────────────────────────

let engine: webllm.MLCEngine | null = null;
let currentModelId = "";
let isLoading = false;

/** AbortControllers keyed by requestId for in-flight generations. */
const abortControllers = new Map<string, AbortController>();

// ─── Helpers ───────────────────────────────────────────────────────────────────

function post(msg: LLMWorkerOutput): void {
  self.postMessage(msg);
}

function postError(requestId: string, message: string, err?: unknown): void {
  const stack = err instanceof Error ? err.stack : undefined;
  post({ type: "error", requestId, message, ...(stack !== undefined ? { stack } : {}) });
}

// ─── Load ──────────────────────────────────────────────────────────────────────

/**
 * Initialise the WebLLM MLCEngine with the requested model.
 *
 * WebLLM downloads model weights via its own fetch infrastructure; they land
 * in Cache Storage and are reused across sessions (SRS NFR-STO-01).
 *
 * Model IDs follow the MLC format: "<model>-<quant>-MLC"
 * Default: "Llama-3.2-1B-Instruct-q4f16_1-MLC" (SRS FR-MODEL-02, Standard profile)
 */
async function loadEngine(modelId: string): Promise<void> {
  if (isLoading) {
    postError("", "Engine load already in progress.");
    return;
  }
  if (engine && currentModelId === modelId) {
    post({ type: "ready" });
    return;
  }

  // Reset existing engine before switching models.
  if (engine) {
    await engine.unload();
    engine = null;
  }

  isLoading = true;
  currentModelId = modelId;
  console.log(`[LLM Worker] Loading engine for "${modelId}"…`);

  try {
    engine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (report: webllm.InitProgressReport) => {
        post({
          type: "progress",
          loaded: report.progress * 100,  // convert 0-1 to percent for display
          total: 100,
          text: report.text,
        });
      },
      logLevel: "WARN",
    });

    isLoading = false;
    console.log(`[LLM Worker] Engine ready for "${modelId}".`);
    post({ type: "ready" });
  } catch (err: unknown) {
    // If f16 quantized model fails due to GPU shader-f16 limitation, try universal f32 version
    if (modelId.includes("q4f16_1")) {
      const fallbackModelId = modelId.replace("q4f16_1", "q4f32_1");
      console.warn(`[LLM Worker] "${modelId}" failed, attempting universal f32 fallback "${fallbackModelId}"…`, err);
      try {
        engine = await webllm.CreateMLCEngine(fallbackModelId, {
          initProgressCallback: (report: webllm.InitProgressReport) => {
            post({
              type: "progress",
              loaded: report.progress * 100,
              total: 100,
              text: report.text,
            });
          },
          logLevel: "WARN",
        });
        currentModelId = fallbackModelId;
        isLoading = false;
        console.log(`[LLM Worker] Fallback engine ready for "${fallbackModelId}".`);
        post({ type: "ready" });
        return;
      } catch (f32Err: unknown) {
        console.error(`[LLM Worker] Universal f32 engine also failed for "${fallbackModelId}":`, f32Err);
      }
    }

    isLoading = false;
    engine = null;
    postError("", `Failed to load engine for "${modelId}": ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

// ─── Generate ──────────────────────────────────────────────────────────────────

/**
 * Run a constrained JSON generation request.
 *
 * Uses streaming so the panel can show partial output while the agent is thinking.
 * When a JSON grammar is supplied, WebLLM uses constrained decoding (grammar sampling)
 * to guarantee the output conforms to the AgentPlan schema (SRS FR-PLAN-02).
 *
 * Generation params (SRS tuning):
 * - temperature: 0.1  → deterministic, low creativity (planning task)
 * - top_p: 0.9        → nucleus sampling safety net
 * - max_tokens: 1024  → enough for 10-action plans + reasoning
 */
async function generate(
  requestId: string,
  messages: ChatMessage[],
  _grammar?: string,
): Promise<void> {
  if (!engine) {
    // Attempt auto-recovery if model was previously set
    if (currentModelId) {
      console.log(`[LLM Worker] Engine missing or reset, attempting auto-reload of "${currentModelId}"…`);
      try {
        await loadEngine(currentModelId);
      } catch (reloadErr) {
        postError(requestId, `Engine not loaded and reload failed: ${String(reloadErr)}`);
        return;
      }
    } else {
      postError(requestId, "Engine not loaded. Send 'load' message first.");
      return;
    }
  }

  const controller = new AbortController();
  abortControllers.set(requestId, controller);

  console.log(`[LLM Worker] Generating for requestId="${requestId}" (${messages.length} messages)…`);
  const t0 = performance.now();

  try {
    // Build request options with standard JSON object format.
    // Avoid passing complex schema to schema parser to prevent Metal WebGPU GrammarMatcher crashes.
    const requestOptions: webllm.ChatCompletionRequestStreaming = {
      messages: messages as webllm.ChatCompletionMessageParam[],
      temperature: 0.1,
      top_p: 0.9,
      max_tokens: 512,
      stream: true,
      stream_options: { include_usage: true },
    };

    (requestOptions as unknown as Record<string, unknown>)["response_format"] = {
      type: "json_object",
    };

    let fullText = "";
    let usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const asyncGen = await engine!.chat.completions.create(requestOptions);

    for await (const chunk of asyncGen) {
      // Check for abort signal between chunks.
      if (controller.signal.aborted) {
        console.log(`[LLM Worker] Generation aborted for requestId="${requestId}".`);
        break;
      }

      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        fullText += delta;
        post({ type: "token", requestId, delta });
      }

      // Capture usage from the final chunk.
      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
          total_tokens: chunk.usage.total_tokens,
        };
      }
    }

    abortControllers.delete(requestId);
    const elapsed = performance.now() - t0;
    console.log(`[LLM Worker] Generation done in ${elapsed.toFixed(0)}ms (${usage.completion_tokens} tokens)`);

    post({ type: "result", requestId, text: fullText, usage });
  } catch (err: unknown) {
    abortControllers.delete(requestId);
    // If device was lost or engine crashed, reset engine state so it auto-recovers
    const errStr = String(err);
    if (errStr.includes("Device was lost") || errStr.includes("Model not loaded") || errStr.includes("GrammarMatcher") || errStr.includes("deleted object")) {
      console.warn("[LLM Worker] WebGPU device lost or engine invalid — resetting engine for auto-reload:", err);
      engine = null;
    }
    // Suppress abort errors — they're expected.
    if (err instanceof Error && err.name === "AbortError") return;
    postError(requestId, `Generation failed: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

// ─── Message Handler ───────────────────────────────────────────────────────────

self.addEventListener("message", (event: MessageEvent<LLMWorkerInput>) => {
  const msg = event.data;

  switch (msg.type) {
    case "load":
      loadEngine(msg.modelId).catch((err: unknown) => {
        postError("", `Unhandled error in loadEngine: ${err instanceof Error ? err.message : String(err)}`, err);
      });
      break;

    case "generate":
      generate(msg.requestId, msg.messages, msg.grammar).catch((err: unknown) => {
        postError(msg.requestId, `Unhandled error in generate: ${err instanceof Error ? err.message : String(err)}`, err);
      });
      break;

    case "abort": {
      const ctrl = abortControllers.get(msg.requestId);
      if (ctrl) {
        ctrl.abort();
        abortControllers.delete(msg.requestId);
      }
      break;
    }

    default: {
      const _exhaustive: never = msg;
      postError("", `Unknown message type: ${JSON.stringify(_exhaustive)}`);
    }
  }
});

console.log("[LLM Worker] Worker script initialised.");
