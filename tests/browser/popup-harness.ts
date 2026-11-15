import type { SessionState } from "../../src/shared/types.js";
const sent: { type: string; [key: string]: unknown }[] = [];
let receive!: (message: unknown) => void;
const state = { listeningEnabled: true, agentState: "Listening", lastTranscript: "Find an item", currentPlan: null,
  siteTask: { version: 1, id: "task-1", tabId: 1, origin: "https://shop.example", goal: "Find an item", status: "awaiting_answer", steps: 0, message: "Which size would you like?", question: "Which size?" } } as SessionState;
Object.assign(window, { chrome: { runtime: {
  id: "fixture", onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
  sendMessage: async (message: typeof sent[number]) => { sent.push(message); return message.type === "GET_SESSION_STATE" ? state : message.type === "GET_MODEL_STATUS" ? {} : { ok: true }; },
  openOptionsPage: () => {},
}, tabs: { create: () => {} } } });
await import("../../src/panel/panel.js");
await new Promise(resolve => setTimeout(resolve, 20));
try {
  if (document.getElementById("task-answer-form")!.hidden) throw new Error("Clarification form not shown");
  const answer = document.getElementById("task-answer") as HTMLInputElement;
  answer.value = "Medium";
  document.getElementById("task-answer-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  if (!sent.some(message => message.type === "SITE_TASK_REPLY" && message.answer === "Medium")) throw new Error("Answer was not bound to task");
  const approval = { ...state, siteTask: { ...state.siteTask!, status: "awaiting_approval", message: "Review this action before continuing.", approval: { id: "approval-1", description: "Activate Add to cart", context: "Blue medium shirt, quantity 1, £20", destination: "https://shop.example", expiresAt: Date.now() + 60_000 } } };
  receive({ type: "SESSION_STATE_UPDATE", state: approval, target: "ui" });
  (document.getElementById("confirm-btn") as HTMLButtonElement).click();
  await new Promise(resolve => setTimeout(resolve, 10));
  if (!sent.some(message => message.type === "SITE_TASK_APPROVE" && message.approvalId === "approval-1")) throw new Error("Approval was not bound to operation");
  receive({ type: "SESSION_STATE_UPDATE", state: approval, target: "ui" });
  if (document.documentElement.scrollWidth > 350) throw new Error("Popup overflows the compact viewport");
  Object.assign(window, { smokeResult: { ok: true, cases: ["clarification UI", "operation-bound approval", "compact viewport without overflow"] } });
} catch (error) { Object.assign(window, { smokeResult: { ok: false, error: String(error) } }); }
