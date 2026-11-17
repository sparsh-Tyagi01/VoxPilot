/** Benchmark only: stage immutable public weights on localhost, run the actual worker. */
import { env } from "@huggingface/transformers";
env.remoteHost = new URL("/", self.location.href).href;
env.remotePathTemplate = "{model}/resolve/{revision}/";
const gpu = (self.navigator as WorkerNavigator & { gpu?: { requestAdapter: unknown } }).gpu;
if (gpu) Object.defineProperty(gpu, "requestAdapter", { value: () => { self.postMessage({ type: "benchmark_gpu_request" }); throw new Error("GPU access is forbidden in the CPU benchmark."); } });
await import("../../src/offscreen/llm/cpu-worker.js");
self.postMessage({ type: "benchmark_worker_started" });
