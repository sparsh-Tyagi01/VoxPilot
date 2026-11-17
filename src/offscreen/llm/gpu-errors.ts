/** Recognize browser/driver variants without treating unrelated mapAsync errors as device loss. */
export function isGPUDeviceLoss(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /(?:\[?device\]?\s+(?:was\s+|is\s+|has\s+been\s+)?lost|GPUDeviceLostInfo|DeviceLostError|VK_ERROR_DEVICE_LOST|GPU\s*timeout|GPU device.*(?:lost|destroyed))/i.test(message);
}

export type GPUFailureCode = "GPU_DEVICE_LOST" | "GPU_BUFFER_INVALIDATED";
/** A cancelled readback can leave the native engine unusable without losing its device. */
export function gpuFailureCode(error: unknown): GPUFailureCode | null {
  if (isGPUDeviceLoss(error)) return "GPU_DEVICE_LOST";
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /(?:mapAsync|GPUBuffer)/i.test(message)
    && /buffer\s+(?:was\s+)?(?:unmapped|destroyed)\s+before\s+mapping\s+(?:was\s+)?resolved/i.test(message)
    ? "GPU_BUFFER_INVALIDATED" : null;
}

/** Available in the installed WebLLM model catalogue; smaller than every selectable profile. */
export const GPU_RECOVERY_MODEL = "SmolLM2-360M-Instruct-q4f16_1-MLC";
export const GPU_RECOVERY_DELAY_MS = 500;
export const GPU_RECOVERY_LOAD_TIMEOUT_MS = 5 * 60_000;
