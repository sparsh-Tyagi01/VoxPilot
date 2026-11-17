import { DEFAULT_HOSTED_SETTINGS, HOSTED_SETTINGS_KEY, HOSTED_CREDENTIAL_KEY, validateHostedSettings, type HostedPlannerSettings } from "@shared/hosted-planner.js";

export async function readHostedRuntimeSettings(): Promise<{ config: HostedPlannerSettings; apiKey: string }> {
  const local = await chrome.storage.local.get(HOSTED_SETTINGS_KEY);
  let config: HostedPlannerSettings;
  try { config = validateHostedSettings(local[HOSTED_SETTINGS_KEY] ?? DEFAULT_HOSTED_SETTINGS); }
  catch { config = { ...DEFAULT_HOSTED_SETTINGS }; }
  const session = await chrome.storage.session.get(HOSTED_CREDENTIAL_KEY);
  const credential = session[HOSTED_CREDENTIAL_KEY] as { endpoint?: unknown; token?: unknown } | undefined;
  const apiKey = credential?.endpoint === config.endpoint && typeof credential.token === "string" ? credential.token : "";
  return { config, apiKey };
}

/** UI responses never contain the key. Credentials are bound to one endpoint. */
export async function hostedSettingsStatus() {
  const { config, apiKey } = await readHostedRuntimeSettings();
  return { ...config, hasApiKey: Boolean(apiKey) };
}

export async function saveHostedSettings(raw: unknown, apiKey?: unknown, forgetKey?: unknown): Promise<void> {
  const config = validateHostedSettings(raw);
  if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > 4096 || /[\r\n]/.test(apiKey))) throw new Error("Enter a valid API key without line breaks (up to 4096 characters).");
  const previous = await readHostedRuntimeSettings();
  const token = typeof apiKey === "string" ? apiKey.trim() : "";
  // Chrome session storage is memory-backed. Explicitly keep it out of content scripts.
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  if (!config.enabled || forgetKey === true || (!token && previous.config.endpoint !== config.endpoint)) {
    await chrome.storage.session.remove(HOSTED_CREDENTIAL_KEY);
  } else if (token) {
    await chrome.storage.session.set({ [HOSTED_CREDENTIAL_KEY]: { endpoint: config.endpoint, token } });
  }
  await chrome.storage.local.set({ [HOSTED_SETTINGS_KEY]: config });
}
