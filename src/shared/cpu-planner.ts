/** Immutable CPU planner artifacts; changing these requires browser requalification. */
import config from "./cpu-planner-config.json";
export const CPU_PLANNER_MODEL = config.modelId;
export const CPU_PLANNER_REVISION = config.revision;
export const CPU_PLANNER_INPUT_TOKENS = 3072;
export const CPU_PLANNER_OUTPUT_TOKENS = 256;
export const CPU_PLANNER_SETUP_TIMEOUT_MS = 15 * 60_000;
