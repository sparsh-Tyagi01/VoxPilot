import { describe, expect, it } from "vitest";
import { isGPUDeviceLoss, gpuFailureCode } from "../src/offscreen/llm/gpu-errors.js";

describe("GPU device-loss classification", () => {
  it.each([
    "Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost.",
    "Device was lost during reload", "GPUDeviceLostInfo", "DeviceLostError", "VK_ERROR_DEVICE_LOST", "Metal GPU Timeout Error",
  ])("recognizes fatal device variant: %s", message => expect(isGPUDeviceLoss(new Error(message))).toBe(true));
  it.each(["mapAsync range is out of bounds", "Model download failed", "Invalid JSON", "grammar matcher error"])("does not mistake ordinary failures for device loss: %s", message => expect(isGPUDeviceLoss(message)).toBe(false));
});
describe("GPU readback invalidation", () => {
  it.each(["unmapped", "destroyed"])("retires a buffer %s before mapping resolves without claiming device loss", state => {
    const error = new DOMException(`Failed to execute 'mapAsync' on 'GPUBuffer': Buffer was ${state} before mapping was resolved.`, "AbortError");
    expect(isGPUDeviceLoss(error)).toBe(false);
    expect(gpuFailureCode(error)).toBe("GPU_BUFFER_INVALIDATED");
  });
  it.each([new DOMException("Request aborted", "AbortError"), new Error("mapAsync range is out of bounds"), "Buffer unmapped normally", "network download cancelled"])("does not turn unrelated cancellation/validation into GPU recovery: %s", error => expect(gpuFailureCode(error)).toBeNull());
});
