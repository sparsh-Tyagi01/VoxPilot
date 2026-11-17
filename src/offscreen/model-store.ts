/** Canonical feature manifest. Inference providers own their caches; no parallel downloader. */
import { MODEL_PROFILE_CONFIG } from "@shared/constants.js";
import { normalizeModelProfile } from "@shared/model-profiles.js";
import { CPU_PLANNER_REVISION, CPU_PLANNER_INPUT_TOKENS } from "@shared/cpu-planner.js";

export function profileManifest(value: string) {
  const profile = normalizeModelProfile(value);
  const config = MODEL_PROFILE_CONFIG[profile];
  return {
    profile, label: config.label,
    recognition: { modelId: config.sttModelId, backend: "wasm" as const, dtype: "q8" as const },
    planner: config.modelId ? { modelId: config.modelId, backend: config.backend, optional: profile !== "cpu", contextWindow: config.backend === "wasm" ? CPU_PLANNER_INPUT_TOKENS : 4096,
      ...(config.backend === "wasm" ? { revision: CPU_PLANNER_REVISION, dtype: "q8" } : {}) } : null,
  };
}
