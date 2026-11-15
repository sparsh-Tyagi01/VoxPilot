import { describe, expect, it } from "vitest";
import { HandleRegistry } from "../src/content/handles.js";

describe("snapshot handle isolation", () => {
  it("never redirects a stale plan handle to a different element after another snapshot", () => {
    const registry = new HandleRegistry();
    const first = {} as Element;
    const second = {} as Element;
    const old = registry.register(first);
    registry.reset();
    const current = registry.register(second);
    expect(current).not.toBe(old);
    expect(registry.resolve(old)).toBeNull();
    expect(registry.resolve(current)).toBe(second);
  });
  it("preserves identity within the same snapshot and refuses invalid handles", () => {
    const registry = new HandleRegistry();
    const element = {} as Element;
    expect(registry.register(element)).toBe(registry.register(element));
    expect(registry.size).toBe(1);
    expect(registry.resolve("button")).toBeNull();
  });
});
