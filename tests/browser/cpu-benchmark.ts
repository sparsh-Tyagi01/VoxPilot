import { CPU_PLANNER_MODEL, CPU_PLANNER_REVISION } from "../../src/shared/cpu-planner.js";
import { decideSiteStep } from "../../src/offscreen/agent/site-planner.js";
import type { SiteDecisionRequest } from "../../src/shared/site-task.js";
import type { PlannerLLMInterface } from "../../src/offscreen/agent/planner.js";
let worker: Worker;
const results = new Map<string, (text: string) => void>();
const errors = new Map<string, (message: string) => void>();
const tokens = new Map<string, (text: string) => void>();
let ready!: () => void; let fail!: (error: Error) => void;
let gpuRequests = 0; let usage: unknown;
let generatedText = "";
let checkingCache = false; let cachedDownloadEvents = 0;
function createWorker(): Worker {
  const created = new Worker(new URL("./cpu-benchmark-worker.ts", import.meta.url), { type: "module" });
  created.addEventListener("error", event => fail?.(new Error(event.message)));
  created.addEventListener("message", event => {
  const value = event.data;
  if (value.type === "benchmark_worker_started") created.postMessage({ type: "load", modelId: CPU_PLANNER_MODEL });
  if (value.type === "benchmark_gpu_request") gpuRequests++;
  if (checkingCache && value.type === "progress" && value.downloading) cachedDownloadEvents++;
  if (value.type === "ready") ready();
  if (value.type === "error") { if (value.requestId) errors.get(value.requestId)?.(value.message); else fail(new Error(value.message)); }
  if (value.type === "token") { generatedText += value.delta; tokens.get(value.requestId)?.(value.delta); }
  if (value.type === "result") { usage = value.usage; results.get(value.requestId)?.(value.text); }
  });
  return created;
}
worker = createWorker();
const llm: PlannerLLMInterface = {
  backend: "wasm",
  postGenerate: (requestId, messages, grammar) => worker.postMessage({ type: "generate", requestId, messages, grammar }),
  onResult: (id, callback) => results.set(id, callback), onError: (id, callback) => errors.set(id, callback), onToken: (id, callback) => tokens.set(id, callback),
  abort: requestId => worker.postMessage({ type: "abort", requestId }),
};
const request: SiteDecisionRequest = { taskId: "benchmark", goal: "Search for backpacks", history: [], answers: [], remainingMs: 120_000,
  observation: { documentId: "fixture", observationId: "obs-1", stateKey: "fixture", url: "https://shop.test", title: "Store", capturedAt: 1, truncated: false,
    elements: [{ handle: "e1", tag: "input", inputType: "search", label: "Search products", context: "Find products", formHandle: "e2", fingerprint: "not-for-model" }],
    forms: [{ handle: "e2", action: "https://shop.test/search", method: "get", search: true, fingerprint: "not-for-model", fields: [{ name: "q", type: "search", populated: false, sensitive: false }] }],
    coverage: { candidates: 1, inspected: 1, limited: false, frames: "top_only" } } };
const samples: { name: string; durationMs: number; validSchema: boolean; correct: boolean; decision?: unknown; usage?: unknown; error?: string; fixtureOutput?: string }[] = [];
try {
  console.info("CPU benchmark: initializing worker and model");
  const started = performance.now();
  await new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  const initializationMs = performance.now() - started;
  console.info(`CPU benchmark: model ready in ${Math.round(initializationMs)} ms`);
  for (const [name, test] of [
    ["search-first", request], ["search-warm", request],
    ["unavailable", { ...request, goal: "Add this to cart", observation: { ...request.observation, title: "Article", textSummary: "A history article about mountains.", elements: [], forms: [] } }],
  ] as const) {
    const time = performance.now();
    generatedText = "";
    console.info(`CPU benchmark: generating ${name}`);
    try {
      const decision = await decideSiteStep(llm, test);
      console.info(`CPU benchmark: ${name} produced valid JSON in ${Math.round(performance.now() - time)} ms`);
      const correct = name === "unavailable" ? decision.kind === "unavailable"
        : decision.kind === "act" && decision.action.type === "type" && decision.action.handle === "e1" && decision.action.text.toLowerCase().trim() === "backpacks";
      samples.push({ name, durationMs: performance.now() - time, validSchema: true, correct, decision, usage });
    } catch (error) { samples.push({ name, durationMs: performance.now() - time, validSchema: false, correct: false, error: String(error), fixtureOutput: generatedText.slice(0, 4000) }); }
  }
  worker.terminate(); checkingCache = true;
  console.info("CPU benchmark: reopening provider-cached weights in a new worker");
  const cachedStarted = performance.now(); worker = createWorker();
  await new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  const cachedInitializationMs = performance.now() - cachedStarted;
  Object.assign(window, { smokeResult: { ok: gpuRequests === 0 && cachedDownloadEvents === 0 && samples.every(sample => sample.correct), gpuFree: gpuRequests === 0,
    cachedInitializationMs, cachedDownloadEvents,
    correctSamples: samples.filter(sample => sample.correct).length, totalSamples: samples.length, model: CPU_PLANNER_MODEL, revision: CPU_PLANNER_REVISION, backend: "wasm", numThreads: 1,
    gpuRequests, initializationMs, cacheCondition: "fresh Chrome profile; weights staged on localhost; warm samples reuse one worker", samples } });
} catch (error) { Object.assign(window, { smokeResult: { ok: false, error: String(error), gpuRequests, samples } }); }
finally { worker.terminate(); }
