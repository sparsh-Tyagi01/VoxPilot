import type { AgentAction, PageSnapshot, ElementHandle } from "./types.js";

export type SiteAction = Extract<AgentAction, { type: "click" | "type" | "select" | "toggle" | "scroll" | "navigate" | "read" }>
  | { type: "submit"; handle: string };
export interface SiteForm {
  handle: string; action: string; method: string; search: boolean;
  fingerprint: string;
  submitLabels?: string[];
  limited?: boolean;
  fields: { name: string; type: string; populated: boolean; sensitive: boolean }[];
}
export interface SiteElement extends ElementHandle {
  fingerprint: string;
  context: string;
  href?: string;
  formHandle?: string;
  readOnly?: boolean;
  options?: string[];
}
export interface SiteObservation extends PageSnapshot {
  documentId: string;
  observationId: string;
  stateKey: string;
  elements: SiteElement[];
  forms: SiteForm[];
  coverage: { candidates: number; inspected: number; limited: boolean; frames: "top_only" };
}
export type SiteExpectation =
  | { kind: "control_state" }
  | { kind: "page_changed" }
  | { kind: "text_appeared"; text: string };
export type LimitationCode = "not_found_in_scope" | "blocked_by_site_state" | "unsupported_by_extension" | "blocked_by_policy";
export type SiteDecision =
  | { kind: "act"; action: SiteAction; expected: SiteExpectation }
  | { kind: "observe"; reason: string }
  | { kind: "ask"; question: string }
  | { kind: "finish"; message: string; evidence: string[] }
  | { kind: "answer"; message: string; evidence: string[] }
  | { kind: "unavailable"; reason: LimitationCode; message: string };
export type SiteTaskStatus = "observing" | "planning" | "awaiting_answer" | "awaiting_approval" | "executing" | "verifying"
  | "completed" | "answered" | "limited" | "unknown" | "cancelled";
export interface SiteApproval {
  id: string; description: string; context: string; destination: string; expiresAt: number;
}
export interface SiteTaskState {
  version: 1; id: string; tabId: number; origin: string; goal: string;
  status: SiteTaskStatus; steps: number; message: string;
  question?: string; approval?: SiteApproval;
}
export interface SiteStepResult {
  dispatched: boolean;
  controlVerified: boolean;
  navigationExpected: boolean;
}
export interface SiteDecisionRequest {
  taskId: string; goal: string; observation: SiteObservation;
  history: { action: string; outcome: string }[];
  answers: string[];
  remainingMs: number;
}
export const SITE_TERMINAL = new Set<SiteTaskStatus>(["completed", "answered", "limited", "unknown", "cancelled"]);
