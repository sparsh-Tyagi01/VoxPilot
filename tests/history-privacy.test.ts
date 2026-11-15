import { expect, it } from "vitest";
import { anonymizeEntry } from "../src/shared/history.js";
it("redacts content in transcripts, URLs, errors and action arguments without mutating the original", () => {
  const original = { id: "test", timestamp: "2026", transcript: "secret", url: "https://secret.example", error: "secret", success: false,
    plan: { intent: "secret", risk: 1, requiresConfirmation: false, actions: [{ type: "type" as const, handle: "e1", text: "secret" }, { type: "click" as const, handle: "e2", label: "secret" }, { type: "done" as const, summary: "secret" }] } };
  expect(JSON.stringify(anonymizeEntry(original))).not.toContain("secret");
  expect(original.plan.actions[0]!.text).toBe("secret");
});
