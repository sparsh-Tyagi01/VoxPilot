import { afterEach, expect, it, vi } from "vitest";
import { cachedProviderFiles } from "../src/offscreen/provider-cache.js";
afterEach(() => vi.unstubAllGlobals());
it("uses exact provider model/revision keys without reading or duplicating weights", async () => {
  const cache = { keys: vi.fn(async () => [
    { url: "https://huggingface.co/org/model/resolve/pinned/onnx/model_quantized.onnx" },
    { url: "https://huggingface.co/org/model/resolve/old/onnx/model_quantized.onnx" },
    { url: "https://huggingface.co/org/other/resolve/pinned/config.json" },
  ]) };
  const open = vi.fn(async () => cache); vi.stubGlobal("caches", { open });
  const files = await cachedProviderFiles("org/model", "pinned", "https://huggingface.co/", "{model}/resolve/{revision}/");
  expect([...files]).toEqual(["onnx/model_quantized.onnx"]);
  expect(open).toHaveBeenCalledWith("transformers-cache");
});
it("tolerates inaccessible cache storage", async () => {
  vi.stubGlobal("caches", { open: async () => { throw Error("Storage disabled"); } });
  expect((await cachedProviderFiles("org/model", "main", "https://huggingface.co/", "{model}/resolve/{revision}/")).size).toBe(0);
});
