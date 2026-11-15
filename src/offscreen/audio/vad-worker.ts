/** Bundled Silero VAD runs independently of both recognition and GPU inference. */
import * as ort from "onnxruntime-web/webgpu";
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = {
  wasm: new URL("../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm", import.meta.url).href,
  mjs: new URL("../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs", import.meta.url).href,
};
let session: ort.InferenceSession | null = null;
let h: ort.Tensor;
let c: ort.Tensor;
const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]));
function reset() {
  h = new ort.Tensor("float32", new Float32Array(128), [2, 1, 64]);
  c = new ort.Tensor("float32", new Float32Array(128), [2, 1, 64]);
}
let queue: Promise<void> = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<{ type: "load" | "reset" | "frame"; epoch: number; audio?: Float32Array }>) => {
  const message = event.data;
  queue = queue.then(async () => {
    if (message.type === "load") {
      session ??= await ort.InferenceSession.create(new URL("../../../node_modules/@ricky0123/vad-web/dist/silero_vad.onnx", import.meta.url).href, { executionProviders: ["wasm"] });
      reset(); self.postMessage({ type: "ready" }); return;
    }
    if (message.type === "reset") { reset(); return; }
    if (!session || !message.audio || message.audio.length !== 512) throw new Error("Invalid speech detector frame");
    const audio = message.audio;
    const result = await session.run({ input: new ort.Tensor("float32", audio, [1, 512]), h, c, sr });
    h = result["hn"]!; c = result["cn"]!;
    self.postMessage({ type: "probability", epoch: message.epoch, probability: Number(result["output"]!.data[0]), audio }, [audio.buffer]);
  }).catch(() => { self.postMessage({ type: "error" }); });
});
