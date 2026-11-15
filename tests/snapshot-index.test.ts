import { afterEach, expect, it, vi } from "vitest";
import { SnapshotBuilder } from "../src/content/snapshot.js";
afterEach(() => vi.unstubAllGlobals());
it("reuses candidate queries until DOM mutations invalidate the index", () => {
  let changed!: () => void;
  const query = vi.fn(() => []);
  vi.stubGlobal("document", { documentElement: {}, title: "test", querySelectorAll: query });
  vi.stubGlobal("window", { location: { href: "https://example.com" } });
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: () => void) { changed = callback; }
    observe() {} disconnect() {} takeRecords() { return []; }
  });
  const index = new SnapshotBuilder();
  const first = index.build(false); const second = index.build(false);
  expect(query).toHaveBeenCalledOnce(); expect(second.documentId).toBe(first.documentId);
  changed(); const third = index.build(false);
  expect(query).toHaveBeenCalledTimes(2); expect(third.revision).toBeGreaterThan(first.revision!);
  index.dispose();
});
