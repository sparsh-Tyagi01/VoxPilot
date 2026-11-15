import { normalizeModelProfile } from "@shared/model-profiles.js";
import type { ModelLoadProgressMsg } from "@shared/messages.js";

export interface DownloadProgress {
  message: ModelLoadProgressMsg;
  percent: number;
  determinate: boolean;
}

export const canonicalProfile = normalizeModelProfile;

/** Subscribe before starting, so cached models cannot finish before the listener exists. */
export function downloadModels(
  profile: string,
  onProgress: (progress: DownloadProgress) => void,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let startAccepted = false;
    let pendingReady: ModelLoadProgressMsg | null = null;
    let percent = 0;
    const expectedProfile = canonicalProfile(profile);

    const cleanup = (): void => {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      options.signal?.removeEventListener("abort", abort);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const accept = (raw: unknown): void => {
      if (settled || !raw || typeof raw !== "object") return;
      const value = raw as Record<string, unknown>;
      if (value["target"] === "offscreen" || value["type"] !== "MODEL_LOAD_PROGRESS") return;
      const message = raw as ModelLoadProgressMsg & { profile?: string };
      if (message.profile && canonicalProfile(message.profile) !== expectedProfile) return;
      if (message.phase === "error") {
        finish(new Error(message.text || "Models could not be loaded. Check your connection and retry."));
        return;
      }
      const fraction = typeof message.progress === "number"
        ? message.progress
        : (typeof message.loaded === "number" && typeof message.total === "number" && message.total > 0)
          ? message.loaded / message.total
          : undefined;
      if (fraction !== undefined && Number.isFinite(fraction)) {
        percent = Math.max(percent, Math.min(99, Math.max(0, Math.round(fraction * 100))));
      }
      if (message.done) percent = 100;
      const determinate = message.done === true || message.phase === "downloading";
      onProgress({ message, percent, determinate });
      if (message.done) {
        if (startAccepted) finish();
        else pendingReady = message;
      }
    };
    const listener = (raw: unknown): boolean => { accept(raw); return false; };
    const abort = (): void => finish(new Error("Model setup was cancelled."));
    const timer = setTimeout(() => {
      finish(new Error("Model setup timed out after 15 minutes. Check your connection and retry; cached files will be reused."));
    }, options.timeoutMs ?? 15 * 60 * 1_000);

    chrome.runtime.onMessage.addListener(listener);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }

    void chrome.runtime.sendMessage({ type: "START_MODEL_DOWNLOAD", profile }).then(async (response: unknown) => {
      if (settled) return;
      if (response && typeof response === "object" && (response as { ok?: boolean }).ok === false) {
        throw new Error((response as { error?: string }).error || "Could not start model setup.");
      }
      startAccepted = true;
      if (pendingReady) { accept(pendingReady); return; }
      // Restore progress when reopening setup or when cached readiness predates the request.
      accept(await chrome.runtime.sendMessage({ type: "GET_MODEL_STATUS" }));
    }).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
