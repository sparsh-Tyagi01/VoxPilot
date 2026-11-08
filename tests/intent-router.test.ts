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
      expect((plan?.actions[0] as any)?.direction).toBe("up");

      const plan2 = router.route("scroll up");
      expect(plan2).not.toBeNull();
      expect(plan2?.intent).toContain("Scroll up");
      expect((plan2?.actions[0] as any)?.direction).toBe("up");
    });

    it("routes navigation commands", () => {
      const backPlan = router.route("go back");
      expect(backPlan).not.toBeNull();
      expect(backPlan?.intent).toContain("Navigate back");

      const backPlan2 = router.route("back");
      expect(backPlan2).not.toBeNull();
      expect(backPlan2?.intent).toContain("Navigate back");

      const reloadPlan = router.route("reload");
      expect(reloadPlan).not.toBeNull();
      expect(reloadPlan?.intent).toContain("Reload the page");

      const refreshPlan = router.route("refresh page");
      expect(refreshPlan).not.toBeNull();
      expect(refreshPlan?.intent).toContain("Reload the page");
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

    it("routes click commands", () => {
      const plan = router.route("click login");
      expect(plan).not.toBeNull();
      expect(plan?.intent).toContain("login");
      expect(plan?.actions[0]?.type).toBe("click");

      const plan2 = router.route("please click on the search button");
      expect(plan2).not.toBeNull();
      expect(plan2?.actions[0]?.type).toBe("click");
    });

    it("routes search queries", () => {
      const plan = router.route("search for Albert Einstein");
      expect(plan).not.toBeNull();
      expect(plan?.intent.toLowerCase()).toContain("albert einstein");
      expect(plan?.actions[0]?.type).toBe("type");
      expect((plan?.actions[0] as any)?.text.toLowerCase()).toBe("albert einstein");
    });

    it("routes tab management commands", () => {
      const newTabPlan = router.route("new tab");
      expect(newTabPlan).not.toBeNull();
      expect(newTabPlan?.actions[0]?.type).toBe("tab");
      expect((newTabPlan?.actions[0] as any)?.operation).toBe("open");

      const closeTabPlan = router.route("close tab");
      expect(closeTabPlan).not.toBeNull();
      expect(closeTabPlan?.actions[0]?.type).toBe("tab");
      expect((closeTabPlan?.actions[0] as any)?.operation).toBe("close");

      const nextTabPlan = router.route("next tab");
      expect(nextTabPlan).not.toBeNull();
      expect(nextTabPlan?.actions[0]?.type).toBe("tab");
      expect((nextTabPlan?.actions[0] as any)?.operation).toBe("switch");
    });

    it("returns null for non-fastpath complex queries needing LLM", () => {
      expect(router.route("fill out my address and click submit")).toBeNull();
      expect(router.route("find the cheapest hotel on this page")).toBeNull();
    });
  });
});

