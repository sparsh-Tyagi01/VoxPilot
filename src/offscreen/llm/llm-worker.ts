/**
 * @file src/offscreen/llm/llm-worker.ts
 * @description LLM Web Worker for on-device agent planning using WebLLM + Llama 3.2.
 *
 * This worker runs in a separate thread and handles:
 * 1. Model loading with progress reporting (weights can be 700MB+)
 * 2. Constrained JSON decoding (grammar-based generation ensures valid AgentPlan)
 * 3. Plan generation from a system prompt + DOM snapshot context
 *
 * Production implementation will use:
 * - Library: @mlc-ai/web-llm
 * - Models: Llama-3.2-1B/3B/8B-Instruct (MLC quantized)
 * - Constrained decoding: WebLLM grammar mode (BNF grammar from JSON Schema)
 *
 * PostMessage interface:
 *
 * Input messages (main thread → worker):
 * ```ts
 * { type: 'load', modelId: string }
 * { type: 'plan', prompt: string, schema: object }
 * { type: 'abort' }
 * ```
 *
 * Output messages (worker → main thread):
 * ```ts
 * { type: 'ready' }
 * { type: 'result', plan: AgentPlan }
 * { type: 'token', text: string }  // streaming token
 * { type: 'error', message: string }
 * { type: 'progress', loaded: number, total: number, modelId: string }
 * ```
 */

import type { AgentPlan } from "@shared/types.js";

// ─── Message Types ────────────────────────────────────────────────────────────

/** Messages the worker receives from the main thread. */
type LLMWorkerInput =
  | { type: "load"; modelId: string }
  | { type: "plan"; prompt: string; schema: object }
  | { type: "abort" };

/** Messages the worker sends to the main thread. */
type LLMWorkerOutput =
  | { type: "ready" }
  | { type: "result"; plan: AgentPlan }
  | { type: "token"; text: string }
  | { type: "error"; message: string; stack?: string }
  | { type: "progress"; loaded: number; total: number; modelId: string };

// ─── Worker State ─────────────────────────────────────────────────────────────

/**
 * TODO: Replace with actual WebLLM engine instance.
 * ```ts
 * import * as webllm from '@mlc-ai/web-llm';
 * let engine: webllm.MLCEngine | null = null;
 * ```
 */
let modelLoaded = false;
let currentModelId = "";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function postResult(msg: LLMWorkerOutput): void {
  self.postMessage(msg);
}

/**
 * Load the LLM model with progress reporting.
 *
 * TODO: Implement with WebLLM:
 * ```ts
 * engine = await webllm.CreateMLCEngine(modelId, {
 *   initProgressCallback: (progress) => {
 *     postResult({
 *       type: 'progress',
 *       loaded: progress.progress * 100,
 *       total: 100,
 *       modelId,
 *     });
 *   },
 * });
 * postResult({ type: 'ready' });
 * ```
 */
async function loadModel(modelId: string): Promise<void> {
  currentModelId = modelId;

  try {
    console.log(`[LLM Worker] Loading model: ${modelId}`);

    // Simulate download progress for the stub
    for (let i = 0; i <= 100; i += 10) {
      await new Promise<void>((r) => setTimeout(r, 50));
      postResult({ type: "progress", loaded: i, total: 100, modelId });
    }

    // TODO: Initialize WebLLM engine here
    modelLoaded = true;
    postResult({ type: "ready" });
    console.log(`[LLM Worker] Model "${modelId}" ready.`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    postResult({ type: "error", message: `Failed to load model: ${message}`, stack });
  }
}

/**
 * Generate an AgentPlan from a prompt using constrained JSON decoding.
 *
 * The `schema` parameter is converted to a BNF grammar and passed to the LLM
 * engine to guarantee that the output is valid JSON conforming to AgentPlan.
 *
 * TODO: Implement with WebLLM:
 * ```ts
 * const grammar = webllm.SchemaToGrammar(schema);
 * const reply = await engine.chat.completions.create({
 *   messages: [{ role: 'user', content: prompt }],
 *   response_format: { type: 'json_object', schema: grammar },
 *   temperature: 0.1,
 *   max_tokens: 1024,
 *   stream: true,
 * });
 *
 * let fullText = '';
 * for await (const chunk of reply) {
 *   const token = chunk.choices[0]?.delta.content ?? '';
 *   fullText += token;
 *   postResult({ type: 'token', text: token });
 * }
 *
 * const plan = JSON.parse(fullText) as AgentPlan;
 * postResult({ type: 'result', plan });
 * ```
 */
async function generatePlan(prompt: string, _schema: object): Promise<void> {
  if (!modelLoaded) {
    postResult({ type: "error", message: "Model not loaded. Send 'load' message first." });
    return;
  }

  try {
    console.log(`[LLM Worker] Generating plan... (prompt length: ${prompt.length})`);

    // TODO: Replace with actual WebLLM constrained generation
    // Stub: return a no-op plan after a simulated delay
    await new Promise<void>((r) => setTimeout(r, 200));

    const stubPlan: AgentPlan = {
      intent: "[LLM not yet implemented]",
      actions: [{ type: "done", summary: "LLM worker is a stub — not yet implemented." }],
      risk: 0,
      requiresConfirmation: false,
    };

    postResult({ type: "result", plan: stubPlan });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    postResult({ type: "error", message: `Plan generation failed: ${message}`, stack });
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

self.addEventListener("message", (event: MessageEvent<LLMWorkerInput>) => {
  const msg = event.data;

  switch (msg.type) {
    case "load":
      loadModel(msg.modelId).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        postResult({ type: "error", message });
      });
      break;

    case "plan":
      generatePlan(msg.prompt, msg.schema).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        postResult({ type: "error", message });
      });
      break;

    case "abort":
      // TODO: Abort in-progress generation via AbortController / engine.interruptGenerate()
      console.log("[LLM Worker] Abort requested.");
      break;

    default:
      console.warn(`[LLM Worker] Unknown message type: ${(msg as { type: string }).type}`);
  }
});

console.log("[LLM Worker] VoxPilot LLM worker initialized.");
