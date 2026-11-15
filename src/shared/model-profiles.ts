import { ModelProfile } from "./types.js";
/** One compatibility mapping shared by setup, settings and the running engine. */
export function normalizeModelProfile(value: string): ModelProfile {
  const aliases: Record<string, ModelProfile> = { lite: ModelProfile.Essential, standard: ModelProfile.Balanced, enhanced: ModelProfile.Powerful };
  return aliases[value] ?? (Object.values(ModelProfile).includes(value as ModelProfile) ? value as ModelProfile : ModelProfile.Essential);
}
