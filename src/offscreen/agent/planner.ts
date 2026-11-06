/**
 * @file src/offscreen/agent/planner.ts
 * @description LLM-based agent planner.
 *
 * The Planner:
 * 1. Builds a system prompt (SRS v2.0 Appendix B) with the page snapshot as context
 * 2. Sends the prompt to the LLM worker for constrained JSON decoding
 * 3. Returns a validated AgentPlan
 *
 * System prompt design principles (SRS Appendix B):
 * - Concise — model is small (1B–8B), context window matters
 * - Structured — labeled sections for TASK, PAGE, ELEMENTS, RULES
 * - Grounded — only allows handles that exist in the snapshot
 * - Safety-biased — instructs model to prefer lower risk tiers
 */

import type { AgentPlan, PageSnapshot, ElementHandle } from "@shared/types.js";
import { AGENT_PLAN_SCHEMA } from "@shared/schema.js";
import { MAX_SNAPSHOT_ELEMENTS, LLM_TIMEOUT_MS } from "@shared/constants.js";

/**
 * Planner uses the LLM worker to produce an AgentPlan from a transcript and
 * the current page DOM snapshot.
 */
export class Planner {
  /**
   * Generate an AgentPlan from a user transcript and the current page snapshot.
   *
   * @param transcript The user's voice command (from STT)
   * @param snapshot The current page DOM snapshot
   * @returns A validated AgentPlan
   * @throws If the LLM times out or produces invalid output
   */
  async plan(transcript: string, snapshot: PageSnapshot): Promise<AgentPlan> {
    const prompt = this.buildPrompt(transcript, snapshot);

    // TODO: Send to LLM worker and await result
    // This is a stub — returns a placeholder plan
    console.log(`[Planner] Planning for: "${transcript}"`);
    console.log(`[Planner] Prompt length: ${prompt.length} chars`);

    // Stub: return a placeholder plan
    const stubPlan: AgentPlan = {
      intent: `Execute: ${transcript}`,
      risk: 1,
      requiresConfirmation: false,
      actions: [
        {
          type: "done",
          summary: "LLM planning not yet implemented. Install the LLM worker to enable full functionality.",
        },
      ],
    };

    return stubPlan;
  }

  /**
   * Build the full system prompt for the LLM.
   * Based on SRS v2.0 Appendix B.
   *
   * @param transcript The user's voice command
   * @param snapshot The current page DOM snapshot
   */
  buildPrompt(transcript: string, snapshot: PageSnapshot): string {
    const elementList = this.formatElements(snapshot.elements);

    return `You are VoxPilot, an on-device voice AI browser agent. Your job is to convert the user's voice command into a structured JSON action plan.

## RULES
1. Only use element handles that appear in the ELEMENTS section below.
2. Prefer the LOWEST risk tier that accomplishes the task.
3. If the task requires a password or sensitive data, use fill_from_vault, never type the value.
4. If you are not sure how to accomplish the task, use the "ask" action.
5. Always end the plan with a "done" action with a brief spoken summary.
6. Output ONLY valid JSON — no markdown, no explanation.

## TASK
${transcript}

## PAGE
URL: ${snapshot.url}
Title: ${snapshot.title}
Captured: ${new Date(snapshot.capturedAt).toISOString()}
${snapshot.truncated ? "(snapshot truncated — only first " + MAX_SNAPSHOT_ELEMENTS + " elements shown)" : ""}

## ELEMENTS
${elementList}

## OUTPUT FORMAT
Output a JSON object conforming to this schema:
${JSON.stringify(AGENT_PLAN_SCHEMA, null, 2)}`;
  }

  /**
   * Format the page elements as a compact, LLM-friendly list.
   * Uses a table-like format to minimize token usage.
   */
  private formatElements(elements: ElementHandle[]): string {
    if (elements.length === 0) return "(no interactive elements found)";

    const lines: string[] = [];

    for (const el of elements) {
      const parts: string[] = [`[${el.handle}]`, el.tag.toUpperCase()];

      if (el.role) parts.push(`role=${el.role}`);
      if (el.inputType) parts.push(`type=${el.inputType}`);
      if (el.label) parts.push(`"${el.label.slice(0, 80)}"`);
      if (el.value) parts.push(`value="${el.value.slice(0, 50)}"`);
      if (el.disabled) parts.push("(disabled)");
      if (!el.inViewport) parts.push("(offscreen)");

      lines.push(parts.join(" "));
    }

    return lines.join("\n");
  }
}
