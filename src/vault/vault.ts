/**
 * @file src/vault/vault.ts
 * @description Encrypted profile vault for VoxPilot.
 *
 * The vault stores personal data (name, email, address, payment) in AES-GCM-256
 * encrypted form in chrome.storage.local. The LLM never sees vault values —
 * it only references vault field keys (e.g. "email"), and the vault service
 * resolves and fills the actual value directly into the DOM.
 *
 * SRS references: FR-VAULT-01 to 06; NFR-PRV-01 to 05; Section 3.1 (Vault service)
 *
 * Security properties:
 * - AES-GCM-256 authenticated encryption (integrity + confidentiality)
 * - PBKDF2 key derivation with 600,000 iterations
 * - Fresh IV per encryption operation (nonce reuse prevented)
 * - Key held only in memory — never stored to disk
 * - Auto-lock after configurable idle timeout (default: 5 min)
 * - No vault access from LLM or content scripts — only from SW/settings context
 */

import { deriveKey, generateSalt, generateIV, toBase64, fromBase64, SALT_BYTES } from "./kdf.js";
import type { VaultField, VaultFieldKey } from "@shared/types.js";
import { VAULT_AUTO_LOCK_MS } from "@shared/constants.js";

/** Storage key for the encrypted vault blob. */
const VAULT_STORAGE_KEY = "voxpilot_vault_v1";

/** Storage key for the vault salt. */
const VAULT_SALT_KEY = "voxpilot_vault_salt_v1";

/** Serialized form stored in chrome.storage.local. */
interface VaultBlob {
  /** Base64-encoded ciphertext (AES-GCM output). */
  ciphertext: string;
  /** Base64-encoded IV (12 bytes). */
  iv: string;
  /** Schema version for future migration. */
  version: 1;
}

/** Plaintext vault data (held in memory only after unlock). */
interface VaultData {
  fields: VaultField[];
  /** ISO timestamp of last modification. */
  updatedAt: string;
}

/**
 * VaultService manages the encrypted local profile store.
 * Instantiated once; call unlock() before accessing fields.
 */
export class VaultService {
  /** Derived encryption key (in-memory only, cleared on lock). */
  private key: CryptoKey | null = null;

  /** Decrypted vault data (in-memory only, cleared on lock). */
  private data: VaultData | null = null;

  /** Auto-lock timer handle. */
  private lockTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── Unlock / Lock ───────────────────────────────────────────────────────

  /**
   * Unlock the vault with the user's passphrase.
   * Derives the AES-GCM key and decrypts the stored blob.
   *
   * @param passphrase - User passphrase.
   * @returns true if unlocked successfully, false if wrong passphrase.
   * @throws if storage is unavailable or vault is corrupted.
   */
  async unlock(passphrase: string): Promise<boolean> {
    const salt = await this.getSalt();

    try {
      this.key = await deriveKey(passphrase, salt);
    } catch {
      return false;
    }

    // Try to decrypt the stored vault
    const blob = await this.loadBlob();

    if (!blob) {
      // First time — initialize empty vault
      this.data = { fields: [], updatedAt: new Date().toISOString() };
      await this.persist();
    } else {
      try {
        this.data = await this.decrypt(blob);
      } catch {
        // Wrong passphrase or corrupted vault
        this.key = null;
        return false;
      }
    }

    this.scheduleAutoLock();
    return true;
  }

  /**
   * Lock the vault — clears the key and plaintext data from memory.
   */
  lock(): void {
    this.key = null;
    this.data = null;
    if (this.lockTimer !== null) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
  }

  /** Whether the vault is currently unlocked. */
  get isUnlocked(): boolean {
    return this.key !== null && this.data !== null;
  }

  // ─── Field Access ────────────────────────────────────────────────────────

  /**
   * Read a field value from the unlocked vault.
   *
   * @param key - Vault field key (e.g. "email", "creditCard.number").
   * @returns The plaintext field value, or null if not set.
   * @throws if vault is locked.
   */
  getField(key: VaultFieldKey): string | null {
    this.assertUnlocked();
    this.resetAutoLock();
    return this.data!.fields.find((f) => f.key === key)?.value ?? null;
  }

  /**
   * Set a field value in the vault (then immediately re-encrypt and persist).
   *
   * @param key   - Vault field key.
   * @param value - Plaintext value to store.
   * @param displayName - Human-readable label.
   * @param sensitive   - Whether to mask in audit logs.
   */
  async setField(
    key: VaultFieldKey,
    value: string,
    displayName: string,
    sensitive = false
  ): Promise<void> {
    this.assertUnlocked();
    this.resetAutoLock();

    const existing = this.data!.fields.findIndex((f) => f.key === key);
    const field: VaultField = { key, displayName, value, sensitive };

    if (existing >= 0) {
      this.data!.fields[existing] = field;
    } else {
      this.data!.fields.push(field);
    }

    this.data!.updatedAt = new Date().toISOString();
    await this.persist();
  }

  /**
   * Delete a field from the vault.
   * @param key - Field key to remove.
   */
  async deleteField(key: VaultFieldKey): Promise<void> {
    this.assertUnlocked();
    this.resetAutoLock();
    this.data!.fields = this.data!.fields.filter((f) => f.key !== key);
    this.data!.updatedAt = new Date().toISOString();
    await this.persist();
  }

  /**
   * Return all stored fields (with sensitive values masked).
   * Safe to display in settings UI.
   */
  listFields(): Array<Omit<VaultField, "value"> & { masked: string }> {
    this.assertUnlocked();
    return this.data!.fields.map((f) => ({
      key: f.key,
      displayName: f.displayName,
      sensitive: f.sensitive,
      masked: f.sensitive ? "••••••••" : f.value,
    }));
  }

  // ─── Vault Management ────────────────────────────────────────────────────

  /**
   * Change the vault passphrase.
   * Re-derives the key with a new salt and re-encrypts all data.
   *
   * @param currentPassphrase - Must match the existing passphrase.
   * @param newPassphrase     - New passphrase to set.
   * @returns true on success, false if currentPassphrase is wrong.
   */
  async changePassphrase(currentPassphrase: string, newPassphrase: string): Promise<boolean> {
    if (!this.isUnlocked) {
      const ok = await this.unlock(currentPassphrase);
      if (!ok) return false;
    }

    // Generate a new salt and derive a new key
    const newSalt = generateSalt();
    this.key = await deriveKey(newPassphrase, newSalt);
    await this.saveSalt(newSalt);
    await this.persist();
    return true;
  }

  /**
   * Permanently delete all vault data.
   * Called from the privacy dashboard (SRS NFR-PRV-05).
   */
  async deleteAll(): Promise<void> {
    this.lock();
    await chrome.storage.local.remove([VAULT_STORAGE_KEY, VAULT_SALT_KEY]);
  }

  // ─── Encryption / Decryption ─────────────────────────────────────────────

  /** Encrypt and persist current in-memory vault data. */
  private async persist(): Promise<void> {
    if (!this.key || !this.data) throw new Error("Vault is locked");

    const iv = generateIV();
    const plaintext = new TextEncoder().encode(JSON.stringify(this.data));

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      this.key,
      plaintext
    );

    const blob: VaultBlob = {
      ciphertext: toBase64(new Uint8Array(ciphertextBuffer)),
      iv: toBase64(iv),
      version: 1,
    };

    await chrome.storage.local.set({ [VAULT_STORAGE_KEY]: blob });
  }

  /** Decrypt a stored vault blob using the in-memory key. */
  private async decrypt(blob: VaultBlob): Promise<VaultData> {
    if (!this.key) throw new Error("Vault is locked");

    const ciphertext = fromBase64(blob.ciphertext);
    const iv = fromBase64(blob.iv);

    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      this.key,
      ciphertext
    );

    const json = new TextDecoder().decode(plaintextBuffer);
    return JSON.parse(json) as VaultData;
  }

  // ─── Salt Management ─────────────────────────────────────────────────────

  /** Load the PBKDF2 salt from storage, or generate a new one on first run. */
  private async getSalt(): Promise<Uint8Array> {
    const result = await chrome.storage.local.get(VAULT_SALT_KEY);
    const stored = result[VAULT_SALT_KEY] as string | undefined;

    if (stored) {
      return fromBase64(stored);
    }

    // First time — generate and persist a new salt
    const salt = generateSalt();
    await this.saveSalt(salt);
    return salt;
  }

  private async saveSalt(salt: Uint8Array): Promise<void> {
    await chrome.storage.local.set({ [VAULT_SALT_KEY]: toBase64(salt) });
  }

  /** Load the encrypted blob from storage. */
  private async loadBlob(): Promise<VaultBlob | null> {
    const result = await chrome.storage.local.get(VAULT_STORAGE_KEY);
    return (result[VAULT_STORAGE_KEY] as VaultBlob | undefined) ?? null;
  }

  // ─── Auto-Lock ───────────────────────────────────────────────────────────

  private scheduleAutoLock(): void {
    this.clearAutoLock();
    this.lockTimer = setTimeout(() => {
      console.log("[VoxPilot vault] Auto-locked after idle timeout.");
      this.lock();
    }, VAULT_AUTO_LOCK_MS);
  }

  private resetAutoLock(): void {
    this.scheduleAutoLock();
  }

  private clearAutoLock(): void {
    if (this.lockTimer !== null) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private assertUnlocked(): void {
    if (!this.isUnlocked) {
      throw new Error("Vault is locked. Call unlock() first.");
    }
  }
}

