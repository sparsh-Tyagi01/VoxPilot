import { describe, it, expect } from "vitest";
import { deriveTriggerWords, generateMacroId, findMatchingMacro, type Macro } from "../src/shared/macros.js";

describe("Macros (FR-MACRO-01 to 03)", () => {
  it("generates collision-resistant macro IDs", () => {
    const id1 = generateMacroId();
    const id2 = generateMacroId();
    expect(id1).toMatch(/^macro_\d+_[a-z0-9]+$/);
    expect(id1).not.toBe(id2);
  });

  it("derives clean trigger words by filtering stop words", () => {
    const words = deriveTriggerWords("Please open the Gmail inbox for me");
    expect(words).toContain("open");
    expect(words).toContain("gmail");
    expect(words).toContain("inbox");
    expect(words).not.toContain("please");
    expect(words).not.toContain("the");
    expect(words).not.toContain("for");
    expect(words).not.toContain("me");
  });

  it("finds matching macro when transcript contains majority of trigger words", () => {
    const testMacro: Macro = {
      id: "macro_123_abc",
      name: "Check morning news",
      triggerWords: ["check", "morning", "news"],
      steps: [
        {
          order: 1,
          action: { type: "navigate", url: "https://news.ycombinator.com" },
        },
      ],
      createdAt: new Date().toISOString(),
      useCount: 0,
    };

    const match = findMatchingMacro("please check morning news today", [testMacro]);
    expect(match).not.toBeNull();
    expect(match?.name).toBe("Check morning news");

    const nonMatch = findMatchingMacro("scroll down the page", [testMacro]);
    expect(nonMatch).toBeNull();
  });
});

