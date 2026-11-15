/** Canonical feature manifest. Inference providers own their caches; no parallel downloader. */
import { MODEL_PROFILE_CONFIG } from "@shared/constants.js";
import { normalizeModelProfile } from "@shared/model-profiles.js";

export function profileManifest(value: string) {
  const profile = normalizeModelProfile(value);
  const config = MODEL_PROFILE_CONFIG[profile];
  return {
    profile, label: config.label,
    recognition: { modelId: config.sttModelId, backend: "wasm" as const, dtype: "q8" as const },
    planner: config.modelId ? { modelId: config.modelId, optional: true, contextWindow: 4096 } : null,
  };
}
