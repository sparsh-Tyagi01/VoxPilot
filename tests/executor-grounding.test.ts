import { afterEach, expect, it, vi } from "vitest";
import { ActionExecutor } from "../src/content/executor.js";
import { HandleRegistry } from "../src/content/handles.js";
afterEach(() => vi.unstubAllGlobals());
it("refuses a click if a page changes the target while scrolling yields", async () => {
  class Button extends EventTarget {
    isConnected = true; label = "Sign in"; click = vi.fn(); scrollIntoView = vi.fn();
    getAttribute(name: string) { return name === "aria-label" ? this.label : null; }
  }
  vi.stubGlobal("HTMLElement", Button);
  const button = new Button();
  vi.stubGlobal("self", { scheduler: { yield: async () => { button.label = "Delete account"; } } });
  const handles = new HandleRegistry(); const handle = handles.register(button as unknown as Element);
  await expect(new ActionExecutor(handles).executeAction({ type: "click", handle, label: "Sign in" })).rejects.toThrow("target changed");
  expect(button.click).not.toHaveBeenCalled();
});
