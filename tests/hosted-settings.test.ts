import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readHostedRuntimeSettings, hostedSettingsStatus, saveHostedSettings } from "../src/sw/hosted-settings.js";
import { HOSTED_SETTINGS_KEY, HOSTED_CREDENTIAL_KEY, type HostedPlannerSettings } from "../src/shared/hosted-planner.js";
let local: Record<string, unknown>, session: Record<string, unknown>;
let access: ReturnType<typeof vi.fn>;
const config: HostedPlannerSettings = { version: 1, enabled: true, endpoint: "https://planner.test/v1/chat/completions", model: "model" };
beforeEach(() => {
  local = {}; session = {}; access = vi.fn(async () => undefined);
  const area = (data: Record<string, unknown>) => ({ get: async (key: string) => ({ [key]: data[key] }), set: async (value: Record<string, unknown>) => { Object.assign(data, value); }, remove: async (key: string) => { delete data[key]; } });
  vi.stubGlobal("chrome", { storage: { local: area(local), session: { ...area(session), setAccessLevel: access } } });
});
afterEach(() => vi.unstubAllGlobals());
it("stores credentials only in trusted session storage and never returns the key to UI", async () => {
  await saveHostedSettings(config, "session-only-token");
  expect(access).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  expect(JSON.stringify(local)).not.toContain("session-only-token");
  expect(session[HOSTED_CREDENTIAL_KEY]).toEqual({ endpoint: config.endpoint, token: "session-only-token" });
  expect(await hostedSettingsStatus()).toEqual({ ...config, hasApiKey: true });
  expect(JSON.stringify(await hostedSettingsStatus())).not.toContain("session-only-token");
});
it("never carries a credential to a newly configured endpoint", async () => {
  await saveHostedSettings(config, "old-service-token");
  await saveHostedSettings({ ...config, endpoint: "https://another.test/v1/chat/completions" }, "");
  expect((await readHostedRuntimeSettings()).apiKey).toBe("");
  expect(session[HOSTED_CREDENTIAL_KEY]).toBeUndefined();
});
it("preserves the key only for the same endpoint, and removes it when disabled", async () => {
  await saveHostedSettings(config, "token"); await saveHostedSettings(config, "");
  expect((await readHostedRuntimeSettings()).apiKey).toBe("token");
  await saveHostedSettings({ ...config, enabled: false });
  expect(session[HOSTED_CREDENTIAL_KEY]).toBeUndefined();
  expect((await hostedSettingsStatus()).enabled).toBe(false);
});
it("fails closed on missing or invalid saved consent", async () => {
  expect((await hostedSettingsStatus()).enabled).toBe(false);
  local[HOSTED_SETTINGS_KEY] = { ...config, version: 0 };
  expect((await hostedSettingsStatus()).enabled).toBe(false);
});
it("rejects invalid new settings before writing either storage area", async () => {
  await expect(saveHostedSettings({ ...config, endpoint: "http://insecure.test/chat" }, "token")).rejects.toThrow("HTTPS");
  await expect(saveHostedSettings(config, "key\nheader")).rejects.toThrow("API key");
  expect(local).toEqual({}); expect(session).toEqual({});
});
