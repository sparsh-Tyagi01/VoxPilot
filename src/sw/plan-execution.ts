import type { AgentPlan } from "@shared/types.js";
import type { VoxPilotMessage } from "@shared/messages.js";

type SendToPage = (tabId: number, message: VoxPilotMessage) => Promise<VoxPilotMessage | null>;

/** Execute once, in plan order. Failed DOM actions are never retried by guessing. */
export async function executeBrowserPlan(tabId: number, plan: AgentPlan, sendToPage: SendToPage, mayContinue: () => Promise<boolean> = async () => true): Promise<void> {
  for (const action of plan.actions) {
    if (!await mayContinue()) throw new Error("Command cancelled.");
    if (action.type === "done" || action.type === "ask") continue;
    if (action.type === "navigate") {
      if (action.url === "javascript:history.back()") await chrome.tabs.goBack(tabId);
      else if (action.url === "javascript:history.forward()") await chrome.tabs.goForward(tabId);
      else if (action.url === "javascript:location.reload()") await chrome.tabs.reload(tabId);
      else {
        const url = new URL(action.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) navigation is allowed.");
        await chrome.tabs.update(tabId, { url: url.href });
      }
    } else if (action.type === "tab") {
      if (action.operation === "open") {
        const url = action.url ?? "chrome://newtab";
        if (url !== "chrome://newtab" && !/^https?:\/\//i.test(url)) throw new Error("Only webpages or a new tab can be opened.");
        await chrome.tabs.create({ url });
      } else if (action.operation === "close") {
        await chrome.tabs.remove(tabId);
      } else {
        const tab = await chrome.tabs.get(tabId);
        const tabs = (await chrome.tabs.query({ windowId: tab.windowId })).sort((a, b) => a.index - b.index);
        const index = tabs.findIndex(item => item.id === tabId);
        if (index < 0 || tabs.length === 0) throw new Error("The command's tab is no longer open.");
        const offset = action.index ?? 1;
        const target = tabs[((index + offset) % tabs.length + tabs.length) % tabs.length];
        if (target?.id !== undefined) await chrome.tabs.update(target.id, { active: true });
      }
    } else {
      const result = await sendToPage(tabId, { type: "EXECUTE_IN_PAGE", plan: { ...plan, actions: [action] } });
      if (result?.type !== "EXECUTION_DONE" || !result.success) {
        throw new Error(result?.type === "EXECUTION_DONE" ? result.error ?? "Page action failed." : "The page did not acknowledge the action.");
      }
    }
  }
}
