import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VaultService } from "../src/vault/vault.js";
import { VAULT_AUTO_LOCK_MS } from "../src/shared/constants.js";
let vault: VaultService;
beforeEach(() => {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", { storage: { local: {
    get: async (key: string) => structuredClone({ [key]: store[key] }),
    set: async (values: Record<string, unknown>) => { Object.assign(store, structuredClone(values)); },
    remove: async (keys: string[]) => { for (const key of keys) delete store[key]; },
  } } });
  vault = new VaultService();
});
afterEach(() => { vault.lock(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("reuses unlocked fields and enforces expiry even when the lock timer is throttled", async () => {
  vi.useFakeTimers();
  expect(await vault.unlock("test passphrase")).toBe(true);
  await vault.setField("email", "example@example.com", "Email");
  expect(vault.getField("email")).toBe("example@example.com");
  expect(vault.getField("email")).toBe("example@example.com");
  vi.setSystemTime(Date.now() + VAULT_AUTO_LOCK_MS + 1);
  expect(vault.isUnlocked).toBe(false);
  expect(() => vault.getField("email")).toThrow("Vault is locked");
});
it("a lock during asynchronous key derivation cannot be undone by the pending unlock", async () => {
  const unlocking = vault.unlock("test passphrase");
  vault.lock();
  expect(await unlocking).toBe(false);
  expect(vault.isUnlocked).toBe(false);
});
it("verifies the current passphrase even when unlocked, and preserves fields after rotation", async () => {
  expect(await vault.unlock("original passphrase")).toBe(true);
  await vault.setField("email", "example@example.com", "Email");
  expect(await vault.changePassphrase("wrong passphrase", "new passphrase")).toBe(false);
  expect(await vault.unlock("original passphrase")).toBe(true);
  expect(await vault.changePassphrase("original passphrase", "new passphrase")).toBe(true);
  vault.lock();
  expect(await vault.unlock("original passphrase")).toBe(false);
  expect(await vault.unlock("new passphrase")).toBe(true);
  expect(vault.getField("email")).toBe("example@example.com");
});
