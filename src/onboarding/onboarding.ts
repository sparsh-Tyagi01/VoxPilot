/**
 * @file src/onboarding/onboarding.ts
 * @description Onboarding flow for VoxPilot.
 *
 * Steps:
 *  0. Privacy explanation
 *  1. Microphone permission grant (must be from a visible extension page, not offscreen)
 *  2. Model profile selection + download
 *  3. Done
 *
 * SRS references: FR-VOICE-06, FR-MODEL-01, FR-MODEL-02, FR-VAULT-01
 */

// ─── Step Management ─────────────────────────────────────────────────────────

const NUM_STEPS = 4;
let currentStep = 0;

function goToStep(step: number): void {
  currentStep = step;

  for (let i = 0; i < NUM_STEPS; i++) {
    const panel = document.getElementById(`step-${i}`);
    const ind   = document.getElementById(`step-ind-${i}`);
    if (!panel || !ind) continue;

    panel.classList.toggle("active", i === step);
    panel.hidden = i !== step;

    ind.classList.remove("active", "done");
    if (i < step)  ind.classList.add("done");
    if (i === step) ind.classList.add("active");

    ind.setAttribute("aria-selected", String(i === step));
  }

  // Announce step change to screen readers
  const panelEl = document.getElementById(`step-${step}`);
  panelEl?.focus();
}

// ─── Step 0 → 1: Privacy ─────────────────────────────────────────────────────

document.getElementById("btn-step0-next")?.addEventListener("click", () => {
  goToStep(1);
});

// ─── Step 1: Microphone Permission ───────────────────────────────────────────

const micStatusText = document.getElementById("mic-status-text")!;
const btnRequestMic = document.getElementById("btn-request-mic") as HTMLButtonElement;

btnRequestMic.addEventListener("click", async () => {
  btnRequestMic.disabled = true;
  micStatusText.textContent = "Requesting microphone permission…";

  try {
    // Request permission from this visible extension page (required by MV3 — FR-VOICE-06)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Immediately release the stream — we don't record here
    stream.getTracks().forEach((t) => t.stop());

    micStatusText.textContent = "✓ Microphone permission granted!";
    micStatusText.style.color = "#10b981";

    if (window.location.hash.includes("mic")) {
      micStatusText.textContent = "✓ Microphone permission granted! Closing tab and returning to VoxPilot…";
      await sleep(1000);
      window.close();
      return;
    }

    // Brief delay so user can read the success message
    await sleep(800);
    goToStep(2);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    micStatusText.textContent = `Permission denied: ${msg}. Please enable it in browser settings.`;
    micStatusText.style.color = "#ef4444";
    btnRequestMic.disabled = false;
  }
});

document.getElementById("btn-step1-back")?.addEventListener("click", () => goToStep(0));

// ─── Step 2: Model Download ───────────────────────────────────────────────────

const profileRadios = document.querySelectorAll<HTMLInputElement>("input[name='profile']");
const downloadBtn   = document.getElementById("btn-download") as HTMLButtonElement;
const progressBar   = document.getElementById("download-progress-bar")!;
const progressFill  = document.getElementById("download-progress-fill")!;
const downloadStatus = document.getElementById("download-status")!;

// Visual selection sync for radio group labels
profileRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    document.querySelectorAll(".model-option").forEach((el) => el.classList.remove("selected"));
    radio.closest(".model-option")?.classList.add("selected");
  });
});

downloadBtn.addEventListener("click", async () => {
  const selectedProfile = Array.from(profileRadios).find((r) => r.checked)?.value ?? "lite";

  downloadBtn.disabled = true;
  progressBar.style.display = "block";
  downloadStatus.textContent = "Starting model download…";

  try {
    // Notify SW to trigger model download with selected profile
    await chrome.runtime.sendMessage({
      type: "START_MODEL_DOWNLOAD",
      profile: selectedProfile,
    });

    // Listen for real MODEL_LOAD_PROGRESS messages from the service worker.
    // Falls back to simulated progress if models are already cached.
    await waitForModelDownload();

    await chrome.storage.local.set({
      onboarding_complete: true,
      selected_profile: selectedProfile,
    });

    goToStep(3);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    downloadStatus.textContent = `Download failed: ${msg}`;
    downloadStatus.style.color = "#ef4444";
    downloadBtn.disabled = false;
  }
});

document.getElementById("btn-step2-back")?.addEventListener("click", () => goToStep(1));

/**
 * Wait for model download to complete via real MODEL_LOAD_PROGRESS messages.
 * Only real model download progress from offscreen workers is accepted (no simulation fallbacks).
 */
function waitForModelDownload(): Promise<void> {
  return new Promise((resolve, reject) => {
    // 15-minute safety timeout for real model downloads
    const timeoutTimer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(progressListener);
      reject(new Error("Model download timed out after 15 minutes. Check your internet connection and retry."));
    }, 15 * 60 * 1_000);

    const progressListener = (msg: unknown): boolean => {
      if (typeof msg !== "object" || msg === null) return false;
      const m = msg as Record<string, unknown>;

      if (m["type"] === "MODEL_LOAD_PROGRESS") {
        let pct = 0;
        let statusText = "";

        if (typeof m["progress"] === "number") {
          pct = Math.round(m["progress"] * 100);
        } else if (typeof (m["llm"] as any)?.loaded === "number") {
          const llm = m["llm"] as any;
          pct = llm.total > 0 ? Math.round((llm.loaded / llm.total) * 100) : Math.round(llm.loaded);
        } else if (typeof (m["stt"] as any)?.loaded === "number") {
          const stt = m["stt"] as any;
          pct = stt.total > 0 ? Math.round((stt.loaded / stt.total) * 100) : Math.round(stt.loaded);
        }

        pct = Math.min(100, Math.max(0, pct));
        statusText = String(m["text"] || (m["llm"] as any)?.text || `Downloading model files… ${pct}%`);

        progressFill.style.width = `${pct}%`;
        progressFill.setAttribute("aria-valuenow", String(pct));
        downloadStatus.textContent = statusText;

        if (m["done"] === true || pct >= 100 || m["phase"] === "ready") {
          clearTimeout(timeoutTimer);
          chrome.runtime.onMessage.removeListener(progressListener);
          downloadStatus.textContent = "✓ Models ready!";
          downloadStatus.style.color = "#10b981";
          resolve();
        }
      }
      return false;
    };

    chrome.runtime.onMessage.addListener(progressListener);
  });
}

// ─── Step 3: Done ─────────────────────────────────────────────────────────────

document.getElementById("btn-done")?.addEventListener("click", async () => {
  // Open side panel and close the onboarding tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
  window.close();
});

document.getElementById("btn-open-settings")?.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/settings/settings.html") });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Init ─────────────────────────────────────────────────────────────────────

// Make all step panels start hidden except step 0
for (let i = 1; i < NUM_STEPS; i++) {
  const panel = document.getElementById(`step-${i}`);
  if (panel) panel.hidden = true;
}

// Check if directed to mic permission request
if (window.location.hash.includes("mic")) {
  goToStep(1);
  setTimeout(() => {
    btnRequestMic.click();
  }, 200);
} else {
  // Check if already onboarded
  (async () => {
    const { onboarding_complete } = await chrome.storage.local.get("onboarding_complete");
    if (onboarding_complete) {
      // Skip to done
      goToStep(3);
    }
  })();
}

