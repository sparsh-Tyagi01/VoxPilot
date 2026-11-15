const CONTENT_MESSAGES = new Set(["IN_PAGE_CONFIRM", "VAULT_FILL_REQUEST", "TAB_OPERATION", "SPEAK", "EXECUTION_DONE", "SNAPSHOT_RESPONSE"]);
const OFFSCREEN_MESSAGES = new Set(["COMMAND_NOTICE", "AGENT_STATE_CHANGED", "AUDIO_LEVEL", "MODEL_LOAD_PROGRESS", "TRANSCRIPT", "PLAN_PRODUCED", "REQUEST_SNAPSHOT", "OFFSCREEN_ERROR", "TTS_DONE", "LLM_TOKEN", "PERFORMANCE_SAMPLE", "RELAY_ACTION"]);
/** Routing hints are not authority. Validate actual Chrome sender metadata. */
export function authorizedSender(type: string, sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  if (sender.id !== extensionId || !sender.url) return false;
  const extensionURL = `chrome-extension://${extensionId}/`;
  const offscreen = sender.url === `${extensionURL}src/offscreen/offscreen.html`;
  if (OFFSCREEN_MESSAGES.has(type)) return offscreen;
  if (sender.url.startsWith(extensionURL)) return !offscreen;
  return sender.tab?.id !== undefined && (sender.frameId ?? 0) === 0 && CONTENT_MESSAGES.has(type);
}
