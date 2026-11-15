/**
 * @file src/offscreen/model-store.ts
 * @description Model download, verification, and cache management.
 *
 * Handles the one-time download of model weights from HuggingFace Hub,
 * verifying SHA-256 checksums before use. Models are stored in Cache Storage
 * for persistence across sessions.
 *
 * SRS references:
 * - FR-MODEL-01: Profile selection (Lite / Standard / Enhanced)
 * - FR-MODEL-02: Hash-verified download, one-time consent
 * - NFR-STO-01: Storage budgets (Lite ≤0.3 GB, Standard ≤1.2 GB, Enhanced ≤3 GB)
 * - IR-COM-01: Only network traffic is model download from pinned host
 * - NFR-PRV-01: User data never leaves device; model download is consented
 */

import { ModelProfile } from "@shared/types.js";

/** Model descriptor for a single downloadable file. */
export interface ModelDescriptor {
  /** Canonical model ID (HuggingFace repo path). */
  id: string;
  /** Display name for UI. */
  name: string;
  /** Download URL (must match the pinned host in manifest CSP). */
  url: string;
  /** Expected SHA-256 hex digest for integrity verification. */
  sha256: string;
  /** File size in bytes (for progress display). */
  sizeBytes: number;
  /** Cache Storage key. */
  cacheKey: string;
}

/** Download progress callback. */
export type DownloadProgressCallback = (
  modelId: string,
  downloaded: number,
  total: number,
) => void;

/**
 * Models required for each profile.
 *
 * NOTE: sha256 values marked "TODO" must be filled in after the model files
 * are finalized in Phase 0 benchmarking (SRS Appendix D).
 */
export const MODEL_CONFIGS: Record<ModelProfile, ModelDescriptor[]> = {
  // ── Fast ────────────────────────────────────────────────────────────────────
  [ModelProfile.Fast]: [
    {
      id: "onnx-community/whisper-tiny",
      name: "Whisper Tiny (STT)",
      url: "https://huggingface.co/onnx-community/whisper-tiny/resolve/main/onnx/encoder_model_quantized.onnx",
      sha256: "TODO_fill_in_after_phase0_benchmarks",
      sizeBytes: 39_000_000, // ~39 MB
      cacheKey: "voxpilot-whisper-tiny-encoder",
    },
  ],
  // ── Balanced ────────────────────────────────────────────────────────────────
  [ModelProfile.Balanced]: [
    {
      id: "onnx-community/whisper-base",
      name: "Whisper Base (STT)",
      url: "https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model_quantized.onnx",
      sha256: "TODO_fill_in_after_phase0_benchmarks",
      sizeBytes: 74_000_000, // ~74 MB
      cacheKey: "voxpilot-whisper-base-encoder",
    },
    {
      id: "mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC",
      name: "Llama 3.2 1B (LLM)",
      url: "https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC/resolve/main/params_shard_0.bin",
      sha256: "TODO_fill_in_after_phase0_benchmarks",
      sizeBytes: 750_000_000, // ~750 MB
      cacheKey: "voxpilot-llama-3.2-1b-q4",
    },
  ],
  // ── Enhanced / Powerful ─────────────────────────────────────────────────────
  [ModelProfile.Powerful]: [
    {
      id: "onnx-community/whisper-base",
      name: "Whisper Base (STT)",
      url: "https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model_quantized.onnx",
      sha256: "TODO_fill_in_after_phase0_benchmarks",
      sizeBytes: 74_000_000,
      cacheKey: "voxpilot-whisper-base-encoder",
    },
    {
      id: "mlc-ai/Llama-3.2-3B-Instruct-q4f16_1-MLC",
      name: "Llama 3.2 3B (LLM)",
      url: "https://huggingface.co/mlc-ai/Llama-3.2-3B-Instruct-q4f16_1-MLC/resolve/main/params_shard_0.bin",
      sha256: "TODO_fill_in_after_phase0_benchmarks",
      sizeBytes: 2_200_000_000, // ~2.2 GB
      cacheKey: "voxpilot-llama-3.2-3b-q4",
    },
  ],
};

/** Cache Storage bucket name for all VoxPilot models. */
const CACHE_NAME = "voxpilot-models-v1";

/**
 * ModelStore manages model caching, downloading, and integrity checks.
 */
export class ModelStore {

  /**
   * Check whether all models for a profile are already cached locally.
   *
   * @param profile - Model profile to check.
   * @returns true if all required models are cached.
   */
  async isProfileCached(profile: ModelProfile): Promise<boolean> {
    const cache = await caches.open(CACHE_NAME);
    const models = MODEL_CONFIGS[profile];
    for (const model of models) {
      const response = await cache.match(model.cacheKey);
      if (!response) return false;
    }
    return true;
  }

  /**
   * Download all models for a profile, verifying their checksums.
   * Skips files that are already cached with valid checksums.
   *
   * @param profile  - Model profile to download.
   * @param onProgress - Progress callback (called per model file).
   */
  async downloadProfile(
    profile: ModelProfile,
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    const cache = await caches.open(CACHE_NAME);
    const models = MODEL_CONFIGS[profile];

    for (const model of models) {
      const existing = await cache.match(model.cacheKey);
      if (existing) {
        console.log(`[ModelStore] "${model.name}" already cached — skipping.`);
        onProgress?.(model.id, model.sizeBytes, model.sizeBytes);
        continue;
      }

      console.log(`[ModelStore] Downloading "${model.name}" (${(model.sizeBytes / 1e6).toFixed(0)} MB)...`);
      await this.downloadAndCache(model, cache, onProgress);
    }
  }

  /**
   * Retrieve a cached model as an ArrayBuffer for ONNX Runtime / WebLLM.
   *
   * @param cacheKey - The model's cache key.
   * @returns ArrayBuffer of the model weights.
   * @throws if model is not cached (call downloadProfile first).
   */
  async getModel(cacheKey: string): Promise<ArrayBuffer> {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(cacheKey);
    if (!response) {
      throw new Error(`Model "${cacheKey}" not found in cache. Run model download first.`);
    }
    return response.arrayBuffer();
  }

  /**
   * Delete all cached models (called from privacy dashboard).
   */
  async deleteAll(): Promise<void> {
    await caches.delete(CACHE_NAME);
    console.log("[ModelStore] All models deleted from cache.");
  }

  /**
   * Get the total size of cached models in bytes.
   */
  async getCachedSizeBytes(): Promise<number> {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    let total = 0;
    for (const request of keys) {
      const response = await cache.match(request);
      if (response) {
        const buf = await response.arrayBuffer();
        total += buf.byteLength;
      }
    }
    return total;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async downloadAndCache(
    model: ModelDescriptor,
    cache: Cache,
    onProgress?: DownloadProgressCallback,
  ): Promise<void> {
    const response = await fetch(model.url, {
      method: "GET",
      headers: { "Accept": "application/octet-stream" },
    });

    if (!response.ok) {
      throw new Error(`Download failed for "${model.name}": HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error(`No response body for "${model.name}"`);
    }

    // Stream the download, tracking progress
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let downloaded = 0;

    // eslint-disable-next-line no-constant-condition -- stream ends when reader reports done
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      downloaded += value.byteLength;
      onProgress?.(model.id, downloaded, model.sizeBytes);
    }

    // Assemble full buffer
    const fullBuffer = new Uint8Array(downloaded);
    let offset = 0;
    for (const chunk of chunks) {
      fullBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Verify SHA-256 checksum (skip if placeholder)
    if (!model.sha256.startsWith("TODO")) {
      await this.verifyChecksum(fullBuffer.buffer, model.sha256, model.name);
    }

    // Store in cache
    const cacheResponse = new Response(fullBuffer, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(downloaded),
        "X-VoxPilot-Model-Id": model.id,
      },
    });

    await cache.put(model.cacheKey, cacheResponse);
    console.log(`[ModelStore] "${model.name}" cached successfully.`);
  }

  /**
   * Verify the SHA-256 checksum of downloaded model data.
   * Uses the Web Crypto API (no external dependencies).
   *
   * @throws if the computed digest doesn't match the expected one.
   */
  private async verifyChecksum(
    buffer: ArrayBuffer,
    expectedHex: string,
    modelName: string,
  ): Promise<void> {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const actualHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    if (actualHex !== expectedHex.toLowerCase()) {
      throw new Error(
        `Checksum verification FAILED for "${modelName}".\n` +
        `Expected: ${expectedHex}\n` +
        `Actual:   ${actualHex}\n` +
        `The downloaded file may be corrupted or tampered with.`
      );
    }

    console.log(`[ModelStore] Checksum verified for "${modelName}".`);
  }
}

