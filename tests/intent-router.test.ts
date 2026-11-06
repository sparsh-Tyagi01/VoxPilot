import { describe, it, expect } from "vitest";
import { IntentRouter } from "../src/offscreen/agent/intent-router.js";
import { RiskTier } from "../src/shared/types.js";

describe("IntentRouter", () => {
  const router = new IntentRouter();

  describe("Kill Switch Detection (FR-SAFE-04)", () => {
    it("identifies direct kill commands, including with punctuation", () => {
      expect(router.isKillCommand("stop")).toBe(true);
      expect(router.isKillCommand("stop.")).toBe(true);
      expect(router.isKillCommand("STOP!")).toBe(true);
      expect(router.isKillCommand("abort")).toBe(true);
      expect(router.isKillCommand("cancel")).toBe(true);
      expect(router.isKillCommand("quit")).toBe(true);
      expect(router.isKillCommand("exit")).toBe(true);
      expect(router.isKillCommand("never mind")).toBe(true);
      expect(router.isKillCommand("stop that")).toBe(true);
      expect(router.isKillCommand("stop it")).toBe(true);
    });

    it("rejects non-kill commands containing kill words", () => {
      expect(router.isKillCommand("stop the bus on the page")).toBe(false);
      expect(router.isKillCommand("click cancel button")).toBe(false);
      expect(router.isKillCommand("search for exit")).toBe(false);
    });
  });

  describe("Undo Command Detection (FR-SAFE-03)", () => {
    it("identifies undo and revert commands", () => {
      expect(router.isUndoCommand("undo")).toBe(true);
      expect(router.isUndoCommand("Undo")).toBe(true);
      expect(router.isUndoCommand("undo that")).toBe(true);
      expect(router.isUndoCommand("please undo that")).toBe(true);
      expect(router.isUndoCommand("undo last action")).toBe(true);
      expect(router.isUndoCommand("revert")).toBe(true);
      expect(router.isUndoCommand("revert that")).toBe(true);
    });

    it("rejects non-undo sentences", () => {
      expect(router.isUndoCommand("undoing the knot")).toBe(false);
      expect(router.isUndoCommand("what can you undo")).toBe(false);
    });
  });

  describe("Fast-Path Intent Routing", () => {
    it("routes scroll-down commands (with variations and punctuation)", () => {
      expect(router.route("scroll down")).not.toBeNull();
      expect(router.route("Scroll down.")).not.toBeNull();
      expect(router.route("scroll down please")).not.toBeNull();
      expect(router.route("can you scroll down?")).not.toBeNull();
      expect(router.route("page down")).not.toBeNull();
      expect(router.route("scroll down a bit")).not.toBeNull();

      const plan = router.route("scroll down");
      expect(plan?.intent).toContain("Scroll down");
      expect(plan?.risk).toBe(RiskTier.R0);
      expect(plan?.actions[0]?.type).toBe("scroll");
    });

    it("routes scroll-up commands", () => {
      const plan = router.route("please scroll up");
      expect(plan).not.toBeNull();
      expect(plan?.intent).toContain("Scroll up");
      expect(plan?.risk).toBe(RiskTier.R0);
    });

    it("routes scroll-to-top commands", () => {
      const plan = router.route("scroll to the top");
      expect(plan).not.toBeNull();
      expect(plan?.intent).toContain("top of the page");
    });

    it("routes scroll-to-bottom commands", () => {
      const plan = router.route("go to bottom");
      expect(plan).not.toBeNull();
      expect(plan?.intent).toContain("bottom of the page");
    });

    it("returns null for non-fastpath complex queries needing LLM", () => {
      expect(router.route("fill out my address and click submit")).toBeNull();
      expect(router.route("find the cheapest hotel on this page")).toBeNull();
    });
  });
});

