/**
 * @file src/vault/kdf.ts
 * @description Key derivation function for the VoxPilot vault.
 *
 * Uses PBKDF2-SHA-256 with 600,000 iterations (OWASP 2024 recommendation).
 * All crypto uses the Web Crypto API — no custom crypto.
 *
 * SRS references: FR-VAULT-02, FR-VAULT-03; NFR-SEC-01; Appendix D open decision #5
 */

/** PBKDF2 iteration count (SRS FR-VAULT-02 minimum: 600,000). */
const PBKDF2_ITERATIONS = 600_000;

/** PBKDF2 hash algorithm. */
const PBKDF2_HASH = "SHA-256";

/** AES-GCM key length in bits. */
const AES_KEY_LENGTH = 256;

/** Salt length in bytes (128-bit salt per OWASP). */
export const SALT_BYTES = 16;

/**
 * Derive an AES-GCM-256 CryptoKey from a user passphrase and a random salt.
 *
 * @param passphrase - User-supplied passphrase (UTF-8 string).
 * @param salt       - 16-byte random salt (from `generateSalt()`).
 * @returns An AES-GCM CryptoKey suitable for encrypt/decrypt.
 */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passphraseBytes = encoder.encode(passphrase);

  // Import passphrase as raw PBKDF2 key material
  const baseKey = await crypto.subtle.importKey(
    "raw",
    passphraseBytes,
    { name: "PBKDF2" },
    false, // Not extractable — key material never leaves the runtime
    ["deriveBits", "deriveKey"]
  );

  // Derive the AES-GCM key
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    baseKey,
    {
      name: "AES-GCM",
      length: AES_KEY_LENGTH,
    },
    false, // Not extractable — key cannot be exported
    ["encrypt", "decrypt"]
  );
}

/**
 * Generate a cryptographically random salt.
 * @returns 16-byte Uint8Array.
 */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/**
 * Generate a cryptographically random AES-GCM IV (nonce).
 * A fresh IV must be used for every encryption operation.
 * @returns 12-byte Uint8Array (96-bit IV, optimal for AES-GCM).
 */
export function generateIV(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12));
}

/**
 * Encode a Uint8Array as a Base64 string for storage in chrome.storage.local.
 */
export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Decode a Base64 string back to a Uint8Array.
 */
export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(
    atob(b64)
      .split("")
      .map((c) => c.charCodeAt(0))
  );
}

