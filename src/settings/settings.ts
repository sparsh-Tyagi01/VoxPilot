import { normalizeModelProfile } from "@shared/model-profiles.js";
import { benchmarkSpeech } from "../diagnostics/speech-benchmark.js";
/**
 * @file src/settings/settings.ts
 * @description Settings page logic for VoxPilot.
 *
 * Handles navigation between sections and all settings interactions:
 * - Voice configuration
 * - Model profile selection
 * - Vault unlock/lock/edit
 * - Privacy dashboard (data deletion)
 * - About info
 *
 * SRS references: FR-VAULT-02 to 06; NFR-PRV-05; IR-UI-07
 */

import { VaultService } from "../vault/vault.js";
import type { VaultFieldKey } from "@shared/types.js";

// ─── Vault Instance ───────────────────────────────────────────────────────────

const vault = new VaultService();

// ─── Navigation ───────────────────────────────────────────────────────────────

const navButtons = document.querySelectorAll<HTMLButtonElement>(".nav-btn");
const sections   = document.querySelectorAll<HTMLElement>(".section");

function showSection(name: string): void {
  sections.forEach((s) => s.classList.toggle("active", s.id === `section-${name}`));
  navButtons.forEach((b) => b.classList.toggle("active", b.dataset["section"] === name));
}

navButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const section = btn.dataset["section"];
    if (section) showSection(section);
  });
});

// Handle hash navigation (e.g., from panel "🔒 On-device" button)
function handleHash(): void {
  const hash = window.location.hash.replace("#", "");
  if (hash && document.getElementById(`section-${hash}`)) {
    showSection(hash);
  }
}

window.addEventListener("hashchange", handleHash);
handleHash();

// ─── Voice Settings ───────────────────────────────────────────────────────────

const idleTimeoutInput  = document.getElementById("idle-timeout") as HTMLInputElement;
const bargeInToggle     = document.getElementById("barge-in") as HTMLInputElement;
const cloudSpeechToggle = document.getElementById("cloud-speech") as HTMLInputElement;

async function loadVoiceSettings(): Promise<void> {
  const { voice_settings } = await chrome.storage.local.get("voice_settings");
  if (voice_settings) {
    idleTimeoutInput.value      = String(voice_settings.idleTimeoutSec ?? 120);
    bargeInToggle.checked       = voice_settings.bargeIn ?? true;
    cloudSpeechToggle.checked   = false;
    (document.getElementById("spoken-confirmations") as HTMLInputElement).checked = voice_settings.spokenConfirmations === true;
  }
}

async function saveVoiceSettings(): Promise<void> {
  await chrome.storage.local.set({
    voice_settings: {
      idleTimeoutSec: parseInt(idleTimeoutInput.value, 10),
      bargeIn: bargeInToggle.checked,
      cloudSpeech: false,
      spokenConfirmations: (document.getElementById("spoken-confirmations") as HTMLInputElement).checked,
    },
  });
}

document.getElementById("spoken-confirmations")?.addEventListener("change", () => { void saveVoiceSettings(); });

idleTimeoutInput.addEventListener("change", () => saveVoiceSettings().catch(console.error));
bargeInToggle.addEventListener("change", () => saveVoiceSettings().catch(console.error));
cloudSpeechToggle.addEventListener("change", () => {
  if (cloudSpeechToggle.checked) {
    const confirmed = window.confirm(
      "⚠ Cloud speech recognition sends your voice to Google's servers.\n\n" +
      "This breaks VoxPilot's privacy-first guarantee. Only enable if you're\n" +
      "willing to share audio with a third party.\n\nEnable anyway?"
    );
    if (!confirmed) {
      cloudSpeechToggle.checked = false;
      return;
    }
  }
  saveVoiceSettings().catch(console.error);
});

// ─── Model Settings ───────────────────────────────────────────────────────────

const modelProfileSelect  = document.getElementById("model-profile") as HTMLSelectElement;
const sttThresholdInput   = document.getElementById("stt-threshold") as HTMLInputElement;

async function loadModelSettings(): Promise<void> {
  const data = await chrome.storage.local.get(["selected_profile", "stt_threshold"]);
  if (data["selected_profile"]) modelProfileSelect.value = normalizeModelProfile(String(data["selected_profile"]));
  if (data["stt_threshold"])    sttThresholdInput.value  = String(data["stt_threshold"]);
}

modelProfileSelect.addEventListener("change", async () => {
  await chrome.storage.local.set({ selected_profile: modelProfileSelect.value });
  chrome.runtime.sendMessage({ type: "PROFILE_CHANGED", profile: modelProfileSelect.value }).catch(() => {});
});

sttThresholdInput.addEventListener("change", async () => {
  await chrome.storage.local.set({ stt_threshold: parseFloat(sttThresholdInput.value) });
});

document.getElementById("btn-redownload")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "START_MODEL_DOWNLOAD", profile: modelProfileSelect.value })
    .catch(console.error);
});

// ─── Vault Settings ───────────────────────────────────────────────────────────

const vaultLockedDiv   = document.getElementById("vault-locked")!;
const vaultUnlockedDiv = document.getElementById("vault-unlocked") as HTMLElement;
const vaultPassphrase  = document.getElementById("vault-passphrase") as HTMLInputElement;
const vaultError       = document.getElementById("vault-error") as HTMLElement;
const vaultFieldsList  = document.getElementById("vault-fields-list")!;

const VAULT_FIELDS: Array<{ key: VaultFieldKey; label: string; sensitive: boolean }> = [
  { key: "fullName",          label: "Full Name",        sensitive: false },
  { key: "email",             label: "Email",            sensitive: false },
  { key: "phone",             label: "Phone",            sensitive: false },
  { key: "address.line1",     label: "Address Line 1",   sensitive: false },
  { key: "address.city",      label: "City",             sensitive: false },
  { key: "address.state",     label: "State",            sensitive: false },
  { key: "address.zip",       label: "ZIP Code",         sensitive: false },
  { key: "creditCard.number", label: "Card Number",      sensitive: true },
  { key: "creditCard.expiry", label: "Card Expiry",      sensitive: true },
  { key: "creditCard.cvv",    label: "CVV",              sensitive: true },
  { key: "password",          label: "Default Password", sensitive: true },
];

document.getElementById("btn-unlock")?.addEventListener("click", async () => {
  const passphrase = vaultPassphrase.value;
  if (!passphrase) return;

  const ok = await vault.unlock(passphrase);
  if (ok) {
    vaultPassphrase.value = "";
    vaultError.hidden = true;
    vaultLockedDiv.hidden = true;
    vaultUnlockedDiv.hidden = false;
    renderVaultFields();
  } else {
    vaultError.textContent = "Wrong passphrase. Please try again.";
    vaultError.hidden = false;
    vaultPassphrase.select();
  }
});

vaultPassphrase.addEventListener("keydown", (e) => {
  if (e.key === "Enter") (document.getElementById("btn-unlock") as HTMLButtonElement)?.click();
});

async function lockRuntimeVault(): Promise<void> {
  await chrome.runtime.sendMessage({ type: "VAULT_LOCK" });
}

document.getElementById("btn-lock-vault")?.addEventListener("click", async () => {
  await lockRuntimeVault();
  vault.lock();
  vaultLockedDiv.hidden = false;
  vaultUnlockedDiv.hidden = true;
  vaultFieldsList.innerHTML = "";
});

// ─── Change Passphrase (FR-VAULT-05) ─────────────────────────────────────────

document.getElementById("btn-change-passphrase")?.addEventListener("click", async () => {
  if (!vault.isUnlocked) {
    window.alert("Please unlock the vault first.");
    return;
  }

  const currentPass = window.prompt("Enter your CURRENT passphrase:");
  if (currentPass === null) return; // User cancelled

  const newPass = window.prompt("Enter a NEW passphrase (at least 12 characters recommended):");
  if (newPass === null) return;
  if (newPass.length < 8) {
    window.alert("Passphrase must be at least 8 characters.");
    return;
  }

  const confirm = window.prompt("Confirm your NEW passphrase:");
  if (confirm !== newPass) {
    window.alert("Passphrases do not match. Please try again.");
    return;
  }

  await lockRuntimeVault();
  const ok = await vault.changePassphrase(currentPass, newPass);
  if (ok) {
    window.alert("✓ Passphrase changed successfully. Your vault has been re-encrypted.");
  } else {
    window.alert("❌ Incorrect current passphrase. Passphrase not changed.");
  }
});

function renderVaultFields(): void {
  vaultFieldsList.innerHTML = "";

  for (const { key, label, sensitive } of VAULT_FIELDS) {
    let currentValue: string | null = null;
    try {
      currentValue = vault.getField(key);
    } catch { /* vault locked */ }

    const row = document.createElement("div");
    row.className = "vault-field-row";

    const nameEl = document.createElement("div");
    nameEl.className = "vault-field-name";
    nameEl.textContent = label;

    const valueEl = document.createElement("div");
    valueEl.className = "vault-field-value";
    valueEl.textContent = currentValue
      ? (sensitive ? "••••••••" : currentValue)
      : "—";

    const editBtn = document.createElement("button");
    editBtn.className = "btn-icon";
    editBtn.textContent = "✏️";
    editBtn.setAttribute("aria-label", `Edit ${label}`);
    editBtn.type = "button";

    editBtn.addEventListener("click", async () => {
      const newValue = window.prompt(`Enter ${label}:`, currentValue ?? "");
      if (newValue !== null) {
        await lockRuntimeVault();
        await vault.setField(key, newValue, label, sensitive);
        currentValue = newValue;
        valueEl.textContent = newValue
          ? (sensitive ? "••••••••" : newValue)
          : "—";
      }
    });

    row.appendChild(nameEl);
    row.appendChild(valueEl);
    row.appendChild(editBtn);
    vaultFieldsList.appendChild(row);
  }
}

// ─── Privacy / Data Deletion ──────────────────────────────────────────────────

document.getElementById("btn-delete-vault")?.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Delete all vault data?\n\nThis removes your name, email, address, and payment data permanently."
  );
  if (confirmed) {
    await lockRuntimeVault();
    await vault.deleteAll();
    window.alert("Vault data deleted.");
    vaultLockedDiv.hidden = false;
    vaultUnlockedDiv.hidden = true;
  }
});

document.getElementById("btn-delete-all")?.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Delete ALL VoxPilot data?\n\nThis removes settings, history, macros, vault, and downloaded models. You will need to re-run setup."
  );
  if (confirmed) {
    await lockRuntimeVault();
    vault.lock();
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    window.alert("All data deleted. Please re-run setup.");
    chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding/onboarding.html") });
  }
});

document.getElementById("btn-show-audit")?.addEventListener("click", async () => {
  const report: unknown = await chrome.runtime.sendMessage({ type: "GET_DIAGNOSTICS" });
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = "voxpilot-performance.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ─── About ────────────────────────────────────────────────────────────────────

const manifest = chrome.runtime.getManifest();
const aboutVersion = document.getElementById("about-version");
if (aboutVersion) aboutVersion.textContent = manifest.version;

// ─── Init ─────────────────────────────────────────────────────────────────────

Promise.all([loadVoiceSettings(), loadModelSettings()]).catch(console.error);


// Diagnostic runs are explicit and use a short local audio file, never microphone capture.
document.getElementById("btn-benchmark")?.addEventListener("click", async () => {
  const button = document.getElementById("btn-benchmark") as HTMLButtonElement;
  const status = document.getElementById("benchmark-status")!;
  const file = (document.getElementById("benchmark-file") as HTMLInputElement).files?.[0];
  if (!file) { status.textContent = "Choose a short spoken-command audio file first."; return; }
  button.disabled = true;
  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_SESSION_STATE" }) as { listeningEnabled: boolean };
    if (state.listeningEnabled) throw new Error("Pause listening before running the benchmark.");
    const report = await benchmarkSpeech(file, text => { status.textContent = text; });
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "voxpilot-speech-benchmark.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = "Benchmark complete. Recognition timings exported; no audio or transcript included.";
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  finally { button.disabled = false; }
});
