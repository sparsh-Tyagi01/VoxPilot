import { expect, it } from "vitest";
import { groundMacroActions } from "../src/sw/macro-grounding.js";
import type { ElementHandle, PageSnapshot } from "../src/shared/types.js";
const snapshot = (labels: string[]): PageSnapshot => ({ url: "https://example.com", title: "", capturedAt: 1, truncated: false,
  elements: labels.map((label, i) => ({ handle: `e${100 + i}`, label } as ElementHandle)),
});
it("rebinds named macro clicks to fresh handles", () => {
  expect(groundMacroActions([{ type: "click", handle: "e1", label: "Submit" }], snapshot(["Submit"]))).toEqual([{ type: "click", handle: "e100", label: "Submit" }]);
});
it("rejects ambiguous, missing and unanchored targets instead of replaying saved handles", () => {
  expect(() => groundMacroActions([{ type: "click", handle: "e1", label: "Submit" }], snapshot(["Submit", "Submit"]))).toThrow("ambiguous");
  expect(() => groundMacroActions([{ type: "click", handle: "e1", label: "Submit" }], snapshot([]))).toThrow("missing");
  expect(() => groundMacroActions([{ type: "type", handle: "e1", text: "example" }], snapshot([]))).toThrow("recorded again");
});
