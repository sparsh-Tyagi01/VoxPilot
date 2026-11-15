/** Recognize browser/driver variants without treating unrelated mapAsync errors as device loss. */
export function isGPUDeviceLoss(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /(?:\[?device\]?\s+(?:was\s+|is\s+|has\s+been\s+)?lost|GPUDeviceLostInfo|DeviceLostError|VK_ERROR_DEVICE_LOST|GPU\s*timeout|GPU device.*(?:lost|destroyed))/i.test(message);
}

/** Available in the installed WebLLM model catalogue; smaller than every selectable profile. */
export const GPU_RECOVERY_MODEL = "SmolLM2-360M-Instruct-q4f16_1-MLC";
export const GPU_RECOVERY_DELAY_MS = 500;
export const GPU_RECOVERY_LOAD_TIMEOUT_MS = 5 * 60_000;
