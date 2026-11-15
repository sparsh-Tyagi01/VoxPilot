import { describe, it, expect } from "vitest";
import { authorizedSender } from "../src/sw/message-policy.js";
describe("runtime authority", () => {
  it("rejects forged inference and privileged settings operations from a page", () => {
    const page = { id: "vox", url: "https://example.com", tab: { id: 1 } } as chrome.runtime.MessageSender;
    expect(authorizedSender("PLAN_PRODUCED", page, "vox")).toBe(false);
    expect(authorizedSender("PROFILE_CHANGED", page, "vox")).toBe(false);
    expect(authorizedSender("VAULT_PASSPHRASE_RESPONSE", page, "vox")).toBe(false);
    expect(authorizedSender("IN_PAGE_CONFIRM", page, "vox")).toBe(true);
  });
  it("separates popup, offscreen and other extensions", () => {
    const popup = { id: "vox", url: "chrome-extension://vox/src/panel/panel.html" };
    expect(authorizedSender("GET_SESSION_STATE", popup, "vox")).toBe(true);
    expect(authorizedSender("PLAN_PRODUCED", popup, "vox")).toBe(false);
    expect(authorizedSender("PLAN_PRODUCED", { ...popup, url: "chrome-extension://vox/src/offscreen/offscreen.html" }, "vox")).toBe(true);
    expect(authorizedSender("GET_SESSION_STATE", { ...popup, id: "other" }, "vox")).toBe(false);
  });
});
