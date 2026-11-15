import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionExecutor } from "../src/content/executor.js";
import { HandleRegistry } from "../src/content/handles.js";
afterEach(() => vi.unstubAllGlobals());
describe("field editing must not submit", () => {
  it.each(["text", "search"])("typing into a %s field never presses Enter or submits its form", async type => {
    class Element extends EventTarget { isConnected = true; focus = vi.fn(); }
    class Input extends Element {
      type = type; private content = "";
      get value() { return this.content; } set value(value: string) { this.content = value; }
      form = { requestSubmit: vi.fn(), submit: vi.fn() };
      dispatchEvent = vi.fn(super.dispatchEvent.bind(this));
    }
    vi.stubGlobal("HTMLElement", Element); vi.stubGlobal("HTMLInputElement", Input);
    vi.stubGlobal("HTMLTextAreaElement", class extends Element {});
    vi.stubGlobal("self", { scheduler: { yield: async () => {} } });
    const input = new Input(); const handles = new HandleRegistry();
    const handle = handles.register(input as unknown as globalThis.Element);
    await new ActionExecutor(handles).executeAction({ type: "type", handle, text: "hello" });
    expect(input.value).toBe("hello");
    expect(input.dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual(["input", "change"]);
    expect(input.form.requestSubmit).not.toHaveBeenCalled(); expect(input.form.submit).not.toHaveBeenCalled();
  });
});
