import type { AgentAction } from "@shared/types.js";

export const EXECUTION_RECEIPT_KEY = "voxpilot_execution_receipt_v1";
export type StepStatus = "dispatched" | "acknowledged" | "uncertain";
export interface ExecutionReceipt {
  executionId: string;
  status: "running" | "completed" | "failed" | "interrupted";
  updatedAt: number;
  steps: { index: number; kind: AgentAction["type"] | "submit"; status: StepStatus }[];
}
/** One bounded receipt in session storage. Contains no action arguments or page data. */
export class ExecutionJournal {
  async read(): Promise<ExecutionReceipt | null> {
    const saved = await chrome.storage.session.get(EXECUTION_RECEIPT_KEY);
    return (saved[EXECUTION_RECEIPT_KEY] as ExecutionReceipt | undefined) ?? null;
  }
  private async write(receipt: ExecutionReceipt): Promise<void> {
    await chrome.storage.session.set({ [EXECUTION_RECEIPT_KEY]: receipt });
  }
  async recover(): Promise<string | null> {
    const receipt = await this.read();
    if (!receipt || receipt.status !== "running") return null;
    receipt.status = "interrupted";
    receipt.updatedAt = Date.now();
    for (const step of receipt.steps) if (step.status === "dispatched") step.status = "uncertain";
    await this.write(receipt);
    return receipt.executionId;
  }
  async begin(executionId: string): Promise<void> {
    await this.write({ executionId, status: "running", updatedAt: Date.now(), steps: [] });
  }
  async step(executionId: string, index: number, kind: AgentAction["type"] | "submit", status: StepStatus): Promise<void> {
    const receipt = await this.read();
    if (!receipt || receipt.executionId !== executionId || receipt.status !== "running") throw new Error("Execution receipt is no longer active.");
    if (!Number.isInteger(index) || index < 0 || index >= 20) throw new Error("Invalid execution step.");
    const step = { index, kind, status };
    const existing = receipt.steps.findIndex(item => item.index === index);
    if (existing < 0) receipt.steps.push(step); else receipt.steps[existing] = step;
    receipt.updatedAt = Date.now();
    await this.write(receipt);
  }
  async finish(executionId: string, success: boolean): Promise<void> {
    const receipt = await this.read();
    if (!receipt || receipt.executionId !== executionId || receipt.status !== "running") return;
    receipt.status = success ? "completed" : "failed";
    receipt.updatedAt = Date.now();
    await this.write(receipt);
  }
}
