export const HOSTED_SETTINGS_KEY = "hosted_planner";
export const HOSTED_CREDENTIAL_KEY = "hosted_planner_credential";
export interface HostedPlannerSettings { version: 1; enabled: boolean; endpoint: string; model: string; }
export const DEFAULT_HOSTED_SETTINGS: HostedPlannerSettings = { version: 1, enabled: false, endpoint: "", model: "" };

/** Only a trusted Settings form supplies the destination; page data never does. */
export function validateHostedSettings(value: unknown): HostedPlannerSettings {
  if (!value || typeof value !== "object") throw new Error("Enter hosted planner settings.");
  const item = value as Record<string, unknown>;
  if (item["version"] !== 1 || typeof item["enabled"] !== "boolean" || typeof item["endpoint"] !== "string" || typeof item["model"] !== "string") throw new Error("Hosted planner settings are invalid.");
  const endpoint = item["endpoint"].trim(), model = item["model"].trim();
  if (model.length > 150 || /[\r\n]/.test(model) || endpoint.length > 2048) throw new Error("The endpoint or model name is too long or invalid.");
  if (item["enabled"] || endpoint) {
    let url: URL; try { url = new URL(endpoint); } catch { throw new Error("Enter the complete chat-completions endpoint URL."); }
    const loopback = ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) throw new Error("Use HTTPS (or HTTP on loopback only), without credentials, query parameters or fragments in the URL.");
    if (item["enabled"] && !model) throw new Error("Enter the model ID supplied by your service.");
    return { version: 1, enabled: item["enabled"], endpoint: url.href, model };
  }
  return { version: 1, enabled: false, endpoint: "", model };
}
