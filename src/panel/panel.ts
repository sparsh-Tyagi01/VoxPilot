/** Compact action popup. Audio and inference belong exclusively to the offscreen document. */
import { AgentState } from "@shared/types.js";
import type { AgentAction, AgentPlan, SessionState } from "@shared/types.js";
import type { ModelLoadProgressMsg, VoxPilotMessage } from "@shared/messages.js";

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing popup element: ${id}`);
  return node as T;
}
const toggle = element<HTMLButtonElement>("toggle-btn");
const toggleLabel = element("toggle-label");
const status = element("status-text");
const transcript = element("transcript");
const result = element("result");
const note = element("listening-note");
const meter = element("audio-meter");
const bars = Array.from(meter.querySelectorAll("i"));
const model = element("model-status");
const modelLabel = element("model-label");
const modelPercent = element("model-percent");
const modelProgress = element("model-progress");
const modelFill = element("model-fill");
const notice = element("notice");
const noticeText = element("notice-text");
const permissionButton = element<HTMLButtonElement>("permission-btn");
const planSection = element("plan");
const planHeading = element("plan-heading");
const planIntent = element("plan-intent");
const planActions = element("plan-actions");
const confirmation = element("confirm-buttons");
const cancelButton = element<HTMLButtonElement>("cancel-btn");
const confirmButton = element<HTMLButtonElement>("confirm-btn");
const vaultForm = element<HTMLFormElement>("vault-form");
const vaultInput = element<HTMLInputElement>("vault-passphrase");
const vaultError = element("vault-error");
const commandInput = element<HTMLInputElement>("command-input");
let listening = false;
let pendingSummary: string | null = null;
let vaultRequestId: string | null = null;
let lastDownloadProgress = 0;
let lastModelPhase = "";

async function send(message: { type: string; [key: string]: unknown }): Promise<unknown> {
  const response: unknown = await chrome.runtime.sendMessage(message);
  if (response && typeof response === "object" && "ok" in response && response.ok === false) {
    throw new Error("error" in response ? String(response.error) : "The request could not be completed. Please retry.");
  }
  return response;
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  notice.hidden = false;
  noticeText.textContent = message;
  permissionButton.hidden = !/microphone|permission|notallowed|not.allowed|getusermedia/i.test(message);
}
function clearError(): void { notice.hidden = true; permissionButton.hidden = true; }

function renderListening(enabled: boolean): void {
  listening = enabled;
  toggle.setAttribute("aria-pressed", String(enabled));
  toggleLabel.textContent = enabled ? "Pause listening" : "Start listening";
  element("mic-icon").toggleAttribute("hidden", enabled);
  element("pause-icon").toggleAttribute("hidden", !enabled);
  meter.hidden = !enabled;
  note.textContent = enabled ? "Mic stays on when you close this popup." : "Voice control, even with this popup closed.";
  if (!enabled) bars.forEach(bar => { bar.style.height = "3px"; });
}

const stateLabels: Record<AgentState, string> = {
  [AgentState.Idle]: "Paused",
  [AgentState.Listening]: "Listening",
  [AgentState.Transcribing]: "Recognizing…",
  [AgentState.Routing]: "Working…",
  [AgentState.Planning]: "Planning…",
  [AgentState.Confirming]: "Needs approval",
  [AgentState.Executing]: "Working…",
  [AgentState.Speaking]: "Speaking",
  [AgentState.Error]: "Needs attention",
};
function renderState(state: AgentState): void {
  status.textContent = !listening && state === AgentState.Listening ? "Paused" : stateLabels[state] ?? "Paused";
  document.body.dataset["state"] = state === AgentState.Error ? "error"
    : state === AgentState.Listening || state === AgentState.Speaking ? (listening ? "active" : "idle")
      : state === AgentState.Idle ? "idle" : "busy";
}
function renderTranscript(text: string): void {
  transcript.textContent = text || "Say “scroll down” or “click Sign in”.";
  transcript.classList.toggle("empty", !text);
}
function hidePlan(): void {
  planSection.hidden = true;
  confirmation.hidden = true;
}
function describeAction(action: AgentAction): string {
  switch (action.type) {
    case "click": return `Click ${action.label ?? action.handle}`;
    case "type": return `Fill ${action.handle}`;
    case "select": return `Select ${action.option}`;
    case "toggle": return `${action.checked ? "Check" : "Uncheck"} ${action.handle}`;
    case "scroll": return `Scroll ${action.direction}`;
    case "navigate": return `Open ${action.url}`;
    case "tab": return `${action.operation === "open" ? "Open" : action.operation === "close" ? "Close" : "Switch"} tab`;
    case "read": return "Read page content";
    case "fill_from_vault": return "Fill a field from your vault";
    case "ask": return action.question;
    case "done": return action.summary;
  }
}
function renderPlan(plan: AgentPlan, focus = false): void {
  const done = plan.actions.find(action => action.type === "done");
  pendingSummary = done?.type === "done" ? done.summary : plan.intent;
  planSection.hidden = false;
  planHeading.textContent = plan.requiresConfirmation ? "Confirm before continuing" : "Working on your command";
  planIntent.textContent = plan.intent;
  planActions.replaceChildren();
  for (const action of plan.actions.filter(action => action.type !== "done")) {
    const item = document.createElement("li");
    item.textContent = describeAction(action);
    planActions.appendChild(item);
  }
  planActions.hidden = planActions.childElementCount === 0;
  confirmation.hidden = !plan.requiresConfirmation;
  confirmButton.disabled = false;
  cancelButton.disabled = false;
  if (focus && plan.requiresConfirmation) cancelButton.focus();
}
function renderSession(state: SessionState): void {
  renderListening(state.listeningEnabled);
  renderState(state.agentState);
  renderTranscript(state.lastTranscript);
  if (state.currentPlan && [AgentState.Confirming, AgentState.Executing, AgentState.Planning].includes(state.agentState)) renderPlan(state.currentPlan);
  else hidePlan();
}
function renderModel(message: ModelLoadProgressMsg): void {
  const phase = message.phase ?? "loading";
  const done = message.done === true || phase === "ready";
  const downloading = /download/i.test(phase);
  // File progress is aggregated by the worker; never turn cached initialization into a download.
  if (lastModelPhase !== phase) lastDownloadProgress = 0;
  const raw = typeof message.progress === "number" ? message.progress * 100
    : message.total && typeof message.loaded === "number" ? message.loaded / message.total * 100 : undefined;
  if (downloading && raw !== undefined && Number.isFinite(raw)) lastDownloadProgress = Math.max(lastDownloadProgress, Math.min(99, Math.max(0, Math.floor(raw))));
  lastModelPhase = phase;
  model.hidden = false;
  modelLabel.textContent = message.text || (done ? "Models ready" : downloading ? "Downloading models…" : "Loading saved models…");
  modelProgress.hidden = done || phase === "error" || phase === "idle";
  modelPercent.hidden = !downloading || raw === undefined || done;
  modelPercent.textContent = `${lastDownloadProgress}%`;
  modelProgress.classList.toggle("indeterminate", !downloading || raw === undefined);
  if (downloading && raw !== undefined) {
    modelProgress.setAttribute("aria-valuenow", String(lastDownloadProgress));
    modelFill.style.width = `${lastDownloadProgress}%`;
  } else {
    modelProgress.removeAttribute("aria-valuenow");
    modelFill.style.removeProperty("width");
  }
  modelProgress.setAttribute("aria-valuetext", modelLabel.textContent);
}

chrome.runtime.onMessage.addListener((raw: unknown) => {
  const message = raw as VoxPilotMessage;
  if (message.target && message.target !== "ui") return;
  switch (message.type) {
    case "SESSION_STATE_UPDATE": renderSession(message.state); break;
    case "AGENT_STATE_CHANGED":
      renderState(message.state);
      if (message.error) showError(message.error);
      break;
    case "MODEL_LOAD_PROGRESS": renderModel(message); break;
    case "AUDIO_LEVEL":
      if (listening) bars.forEach((bar, index) => { bar.style.height = `${Math.round(3 + Math.min(1, Math.max(0, message.level) * 8) * [4, 7, 10, 7, 4][index]!)}px`; });
      break;
    case "TRANSCRIPT_UPDATE": renderTranscript(message.text); result.hidden = true; clearError(); break;
    case "PLAN_READY": renderPlan(message.plan, true); break;
    case "EXECUTION_DONE":
      if (!message.success && message.error) showError(message.error);
      else if (message.success && pendingSummary) {
        result.textContent = pendingSummary;
        result.hidden = false;
      }
      pendingSummary = null;
      hidePlan();
      break;
    case "SPEAKING": result.textContent = message.text; result.hidden = false; break;
    case "VAULT_PASSPHRASE_REQUEST":
      vaultRequestId = message.requestId;
      vaultForm.hidden = false;
      vaultError.hidden = true;
      vaultInput.focus();
      break;
    case "VAULT_UNLOCK_FAILED":
      if (vaultRequestId === message.requestId) {
        vaultForm.hidden = true;
        vaultInput.value = "";
        vaultRequestId = null;
        showError("Couldn’t unlock your vault. Check your passphrase in Settings, then repeat the command.");
      }
      break;
  }
});

toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  clearError();
  try {
    await send({ type: "TOGGLE_LISTENING" });
    const state = await send({ type: "GET_SESSION_STATE" });
    if (state && typeof state === "object" && "listeningEnabled" in state) renderSession(state as SessionState);
  } catch (error) { showError(error); }
  finally { toggle.disabled = false; }
});
permissionButton.addEventListener("click", () => { void chrome.tabs.create({ url: chrome.runtime.getURL("src/onboarding/onboarding.html#mic") }); });
element("settings-btn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage(() => {
    if (chrome.runtime.lastError) showError(chrome.runtime.lastError.message ?? "Could not open settings.");
  });
});
element("commands-btn").addEventListener("click", () => {
  const button = element<HTMLButtonElement>("commands-btn");
  const commands = element("commands");
  commands.hidden = !commands.hidden;
  button.setAttribute("aria-expanded", String(!commands.hidden));
  if (!commands.hidden) commandInput.focus();
});
element<HTMLFormElement>("command-form").addEventListener("submit", async event => {
  event.preventDefault();
  const text = commandInput.value.trim();
  if (!text) return;
  const button = element<HTMLFormElement>("command-form").querySelector("button")!;
  button.disabled = true;
  clearError();
  try {
    if (!listening) await send({ type: "TOGGLE_LISTENING" });
    await send({ type: "DIRECT_TRANSCRIPT", text });
    commandInput.value = "";
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
});
confirmButton.addEventListener("click", async () => {
  confirmButton.disabled = true;
  cancelButton.disabled = true;
  try { await send({ type: "CONFIRM_PLAN" }); confirmation.hidden = true; }
  catch (error) { showError(error); confirmButton.disabled = false; cancelButton.disabled = false; }
});
cancelButton.addEventListener("click", async () => {
  try { await send({ type: "CANCEL_PLAN" }); pendingSummary = null; hidePlan(); }
  catch (error) { showError(error); }
});
vaultForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!vaultRequestId || !vaultInput.value) return;
  const requestId = vaultRequestId;
  const passphrase = vaultInput.value;
  vaultInput.value = "";
  try {
    await send({ type: "VAULT_PASSPHRASE_RESPONSE", requestId, passphrase });
    if (vaultError.hidden) vaultForm.hidden = true;
  } catch (error) { showError(error); }
});
element("vault-cancel").addEventListener("click", () => {
  if (vaultRequestId) void send({ type: "VAULT_PASSPHRASE_RESPONSE", requestId: vaultRequestId, passphrase: "" }).catch(showError);
  vaultInput.value = "";
  vaultForm.hidden = true;
  vaultRequestId = null;
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !confirmation.hidden) { event.preventDefault(); cancelButton.click(); }
});

async function initialize(): Promise<void> {
  const responses = await Promise.allSettled([
    send({ type: "GET_SESSION_STATE" }),
    send({ type: "GET_MODEL_STATUS" }),
  ]);
  const session = responses[0];
  if (session?.status === "fulfilled" && session.value && typeof session.value === "object" && "listeningEnabled" in session.value) renderSession(session.value as SessionState);
  else if (session?.status === "rejected") showError(session.reason);
  const modelStatus = responses[1];
  if (modelStatus?.status === "fulfilled" && modelStatus.value && typeof modelStatus.value === "object" && "type" in modelStatus.value && modelStatus.value.type === "MODEL_LOAD_PROGRESS") renderModel(modelStatus.value as ModelLoadProgressMsg);
}
void initialize().catch(showError);
// Closing the popup deliberately has no effect on audio, models, or listening state.
