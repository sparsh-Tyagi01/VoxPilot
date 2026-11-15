import { describe, expect, it } from "vitest";
import { isGPUDeviceLoss } from "../src/offscreen/llm/gpu-errors.js";

describe("GPU device-loss classification", () => {
  it.each([
    "Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost.",
    "Device was lost during reload", "GPUDeviceLostInfo", "DeviceLostError", "VK_ERROR_DEVICE_LOST", "Metal GPU Timeout Error",
  ])("recognizes fatal device variant: %s", message => expect(isGPUDeviceLoss(new Error(message))).toBe(true));
  it.each(["mapAsync range is out of bounds", "Model download failed", "Invalid JSON", "grammar matcher error"])("does not mistake ordinary failures for device loss: %s", message => expect(isGPUDeviceLoss(message)).toBe(false));
});
