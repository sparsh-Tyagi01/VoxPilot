import type { HostedPlannerSettings } from "../../src/shared/hosted-planner.js";
let config: HostedPlannerSettings = { version: 1, enabled: false, endpoint: "", model: "" };
let hasApiKey = false;
const sent: { type: string; config?: HostedPlannerSettings; apiKey?: string; forgetKey?: boolean }[] = [];
Object.assign(window, { chrome: {
  runtime: { getManifest: () => ({ version: "test" }), sendMessage: async (message: typeof sent[number]) => {
    sent.push(message);
    if (message.type === "GET_HOSTED_SETTINGS") return { ...config, hasApiKey };
    if (message.type === "SAVE_HOSTED_SETTINGS") { config = message.config!; hasApiKey = config.enabled && Boolean(message.apiKey || (hasApiKey && !message.forgetKey)); return { ok: true }; }
    return { ok: true };
  } }, storage: { local: { get: async () => ({ selected_profile: "hosted" }), set: async () => {} } },
} });
await import("../../src/settings/settings.js");
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 30)); };
await settle();
try {
  location.hash = "model"; window.dispatchEvent(new HashChangeEvent("hashchange"));
  const form = document.getElementById("hosted-form") as HTMLFormElement;
  const endpoint = document.getElementById("hosted-endpoint") as HTMLInputElement;
  const model = document.getElementById("hosted-model") as HTMLInputElement;
  const key = document.getElementById("hosted-key") as HTMLInputElement;
  const consent = document.getElementById("hosted-consent") as HTMLInputElement;
  if (form.hidden || consent.checked || hasApiKey) throw new Error("Hosted assist was enabled without explicit consent");
  endpoint.value = "https://planner.example/v1/chat/completions"; model.value = "configured-model"; key.value = "synthetic-session-key";
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await settle();
  if (sent.some(message => message.type === "SAVE_HOSTED_SETTINGS")) throw new Error("Settings were sent without checked sharing consent");
  consent.checked = true; form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await settle();
  if (!config.enabled || !hasApiKey || key.value) throw new Error("Enabled configuration or cleared session-key input is incorrect");
  endpoint.dispatchEvent(new Event("input", { bubbles: true }));
  if (consent.checked) throw new Error("Changing the service did not reset sharing consent");
  (document.getElementById("hosted-disable") as HTMLButtonElement).click(); await settle();
  endpoint.focus(); endpoint.blur(); await settle();
  if (config.enabled || hasApiKey) throw new Error("Disable did not clear service consent and the session key");
  if (document.documentElement.scrollWidth > innerWidth) throw new Error("Settings overflows its viewport");
  if (innerWidth < 700 && document.getElementById("profile-help")!.getBoundingClientRect().width < 250) throw new Error("Narrow Settings compresses the profile explanation into a thin column");
  Object.assign(window, { smokeResult: { ok: true, cases: ["explicit sharing consent", "session key field cleared after save", "endpoint edits reset consent", "disable removes key", "settings fit viewport"] } });
} catch (error) { Object.assign(window, { smokeResult: { ok: false, error: String(error) } }); }
