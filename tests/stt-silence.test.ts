import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ asr: vi.fn(async () => ({ text: "Thank you for watching" })) }));
vi.mock("@huggingface/transformers", () => ({ env: { backends: { onnx: { wasm: {} } } }, pipeline: async () => mock.asr }));
afterEach(() => vi.unstubAllGlobals());
it("silence returns an empty transcript without running Whisper's decoder", async () => {
  let receive!: (event: { data: unknown }) => void;
  const post = vi.fn();
  vi.stubGlobal("self", { postMessage: post, addEventListener: (_: string, cb: typeof receive) => { receive = cb; } });
  await import("../src/offscreen/stt/stt-worker.js");
  receive({ data: { type: "load", modelId: "test" } });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  receive({ data: { type: "transcribe", audio: new Float32Array(16000) } });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(mock.asr).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "result", text: "" }));
});
