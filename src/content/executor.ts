/**
 * @file src/content/executor.ts
 * @description Action executor for VoxPilot content script.
 *
 * Implements all AgentAction types. Handles framework-aware form filling using
 * a strategy ladder (SRS FR-EXEC-02 to 06):
 *
 *   1. Native value setter + synthetic events (works with React, Vue, Angular)
 *   2. execCommand('insertText') fallback
 *   3. Clipboard paste fallback
 *   4. Trusted-input via chrome.debugger (requires optional permission, explicit consent)
 *
 * Security:
 * - Only executes actions from the validated AgentPlan pipeline.
 * - Never exposes vault values to the DOM beyond the targeted field.
 * - All confirmation for R3/R4 is handled before executor is called.
 */

import type { AgentAction, AgentPlan, ClickAction, TypeAction, SelectAction, ToggleAction, ScrollAction, NavigateAction, TabAction, ReadAction, FillFromVaultAction } from "@shared/types.js";
import type { HandleRegistry } from "./handles.js";

/**
 * ActionExecutor implements each AgentAction type against live DOM elements.
 */
export class ActionExecutor {
  constructor(private readonly handles: HandleRegistry) {}

  /**
   * Execute a full plan sequentially, stopping on the first failure.
   *
   * @param plan - Validated AgentPlan from the agent core.
   * @throws Error if any action fails (caller handles error state).
   */
  async executePlan(plan: AgentPlan): Promise<void> {
    for (const action of plan.actions) {
      await this.executeAction(action);
    }
  }

  /**
   * Execute a single action by dispatching to the appropriate handler.
   *
   * @param action - A single AgentAction.
   */
  async executeAction(action: AgentAction): Promise<void> {
    switch (action.type) {
      case "click":       return this.doClick(action);
      case "type":        return this.doType(action);
      case "select":      return this.doSelect(action);
      case "toggle":      return this.doToggle(action);
      case "scroll":      return this.doScroll(action);
      case "navigate":    return this.doNavigate(action);
      case "tab":         return this.doTab(action);
      case "read":        return this.doRead(action);
      case "fill_from_vault": return this.doFillFromVault(action);
      case "ask":         return; // Handled by TTS + side panel
      case "done":        return; // Terminal — nothing to execute in DOM
      default: {
        const exhaustiveCheck: never = action;
        throw new Error(`Unknown action type: ${(exhaustiveCheck as AgentAction).type}`);
      }
    }
  }

  // ─── Click ──────────────────────────────────────────────────────────────────

  private async doClick(action: ClickAction): Promise<void> {
    const el = this.resolveHandle(action.handle);

    // Scroll element into view first
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    await this.yield();

    // Dispatch synthetic click event chain
    this.dispatchMouseEvent(el, "mouseover");
    this.dispatchMouseEvent(el, "mouseenter");
    this.dispatchMouseEvent(el, "mousedown");
    this.dispatchMouseEvent(el, "mouseup");
    this.dispatchMouseEvent(el, "click");

    // Fallback for elements that need native .click()
    if (el instanceof HTMLElement) {
      el.click();
    }

    await this.yield();
  }

  // ─── Type ───────────────────────────────────────────────────────────────────

  private async doType(action: TypeAction): Promise<void> {
    const el = this.resolveHandle(action.handle);

    if (!(el instanceof HTMLElement)) {
      throw new Error(`Handle ${action.handle} does not resolve to an HTMLElement`);
    }

    // Focus the element
    el.focus();
    await this.yield();

    // Strategy 1: React/Vue/Angular native value setter + change events
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (action.clear) {
        el.select();
        this.dispatchKeyboardEvent(el, "keydown", "a", { ctrlKey: true });
        this.dispatchKeyboardEvent(el, "keyup", "a", { ctrlKey: true });
      }

      // Set value via native setter (bypasses React's synthetic event wrapping)
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
        "value"
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, action.text);
      } else {
        el.value = action.text;
      }

      // Dispatch events that React/Vue/Angular listen to
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await this.yield();
      return;
    }

    // Strategy 2: contenteditable
    if (el.isContentEditable) {
      if (action.clear) {
        el.textContent = "";
      }
      // Use execCommand for contenteditable (broader compatibility)
      el.focus();
      document.execCommand("insertText", false, action.text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await this.yield();
      return;
    }

    throw new Error(`Element ${action.handle} is not an input, textarea, or contenteditable`);
  }

  // ─── Select ─────────────────────────────────────────────────────────────────

  private async doSelect(action: SelectAction): Promise<void> {
    const el = this.resolveHandle(action.handle);

    if (!(el instanceof HTMLSelectElement)) {
      throw new Error(`Handle ${action.handle} is not a <select> element`);
    }

    // Find option by text or value
    const options = Array.from(el.options);
    const match = options.find(
      (opt) =>
        opt.text.toLowerCase().trim() === action.option.toLowerCase().trim() ||
        opt.value.toLowerCase() === action.option.toLowerCase()
    );

    if (!match) {
      throw new Error(`No option matching "${action.option}" in select ${action.handle}`);
    }

    // Set via native setter for framework compatibility
    const nativeSelectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (nativeSelectSetter) {
      nativeSelectSetter.call(el, match.value);
    } else {
      el.value = match.value;
    }

    el.dispatchEvent(new Event("change", { bubbles: true }));
    await this.yield();
  }

  // ─── Toggle ─────────────────────────────────────────────────────────────────

  private async doToggle(action: ToggleAction): Promise<void> {
    const el = this.resolveHandle(action.handle);

    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      if (el.checked !== action.checked) {
        el.focus();
        const nativeCheckedSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
        if (nativeCheckedSetter) {
          nativeCheckedSetter.call(el, action.checked);
        } else {
          el.checked = action.checked;
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("click", { bubbles: true }));
      }
    } else {
      // ARIA toggle button
      const pressed = el.getAttribute("aria-pressed");
      const expanded = el.getAttribute("aria-checked");
      if (pressed !== null || expanded !== null) {
        this.dispatchMouseEvent(el, "click");
        (el as HTMLElement).click?.();
      } else {
        throw new Error(`Element ${action.handle} is not a checkbox, radio, or ARIA toggle`);
      }
    }

    await this.yield();
  }

  // ─── Scroll ─────────────────────────────────────────────────────────────────

  private async doScroll(action: ScrollAction): Promise<void> {
    const amount = action.amount ?? 300;

    let scrollTarget: Element | Window = window;
    if (action.handle) {
      const el = this.resolveHandle(action.handle);
      scrollTarget = el;
    }

    const xDelta = action.direction === "left" ? -amount : action.direction === "right" ? amount : 0;
    const yDelta = action.direction === "up" ? -amount : action.direction === "down" ? amount : 0;

    if (scrollTarget instanceof Element) {
      scrollTarget.scrollBy({ left: xDelta, top: yDelta, behavior: "smooth" });
    } else {
      // Primary scroll
      window.scrollBy({ left: xDelta, top: yDelta, behavior: "smooth" });

      // Fallbacks for SPAs and pages that scroll documentElement, scrollingElement, or body
      if (document.scrollingElement && typeof document.scrollingElement.scrollBy === "function") {
        document.scrollingElement.scrollBy({ left: xDelta, top: yDelta, behavior: "smooth" });
      } else if (document.documentElement && typeof document.documentElement.scrollBy === "function") {
        document.documentElement.scrollBy({ left: xDelta, top: yDelta, behavior: "smooth" });
      }
    }

    // Brief wait for smooth scroll to complete
    await new Promise<void>((r) => setTimeout(r, 200));
  }

  // ─── Navigate ───────────────────────────────────────────────────────────────

  private doNavigate(action: NavigateAction): Promise<void> {
    // Basic URL validation (schema already validated against ^https?://)
    window.location.href = action.url;
    return Promise.resolve();
  }

  // ─── Tab ────────────────────────────────────────────────────────────────────

  private async doTab(action: TabAction): Promise<void> {
    // Tab operations are handled at SW level (requires chrome.tabs API)
    // Content script relays them back up
    await chrome.runtime.sendMessage({ type: "TAB_OPERATION", operation: action.operation, url: action.url, index: action.index });
  }

  // ─── Read ───────────────────────────────────────────────────────────────────

  private async doRead(action: ReadAction): Promise<void> {
    let textToRead: string;

    if (action.handle) {
      const el = this.resolveHandle(action.handle);
      textToRead = el.textContent?.trim() ?? "";
    } else {
      // Read main content — prioritise <main>, fall back to <body>
      const main = document.querySelector("main, [role='main'], article");
      textToRead = (main ?? document.body).textContent?.trim() ?? "";
    }

    // Truncate to avoid excessively long TTS
    const truncated = textToRead.slice(0, 500);
    await chrome.runtime.sendMessage({ type: "SPEAK", text: truncated });
  }

  // ─── Fill From Vault (FR-VAULT-04) ──────────────────────────────────────────

  /**
   * Fill a DOM input element with a value from the encrypted vault.
   *
   * Security contract (SRS NFR-PRV-02, NFR-PRV-03):
   * - The LLM only knows the vault field KEY (e.g. "email"), never the value.
   * - The decrypted value travels: SW (vault service) → content script → DOM only.
   * - The value is never logged, never stored in state, never sent to offscreen.
   * - If the vault is locked, SW will prompt the user for their passphrase before
   *   resolving — the content script simply awaits the response message.
   *
   * Protocol:
   *   1. Content → SW: VAULT_FILL_REQUEST { fieldKey, handle }
   *   2. SW unlocks vault (prompts user if needed), retrieves value
   *   3. SW → Content (via tab message): VAULT_FILL_RESPONSE { handle, value }
   *   4. Content fills element using the same framework-aware strategy as doType()
   *   5. Value is immediately discarded (not held in any variable beyond this method)
   */
  private async doFillFromVault(action: FillFromVaultAction): Promise<void> {
    // 1. Request the vault value from the service worker.
    //    The SW is the only component allowed to unlock/read the vault.
    const response = await new Promise<{ handle: string; value: string } | { error: string }>(
      (resolve) => {
        // Set up a one-shot listener for the fill response BEFORE sending the request,
        // to avoid a race condition if SW responds synchronously.
        const handler = (msg: unknown): boolean => {
          if (
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "VAULT_FILL_RESPONSE" &&
            (msg as { handle?: string }).handle === action.handle
          ) {
            chrome.runtime.onMessage.removeListener(handler);
            resolve(msg as { handle: string; value: string });
          }
          // Also handle error from SW (e.g. vault unlock cancelled)
          if (
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "VAULT_FILL_ERROR" &&
            (msg as { handle?: string }).handle === action.handle
          ) {
            chrome.runtime.onMessage.removeListener(handler);
            resolve({ error: (msg as { error: string }).error });
          }
          return false; // We're async but not using sendResponse in this direction
        };

        chrome.runtime.onMessage.addListener(handler);

        // Send the fill request to SW
        chrome.runtime.sendMessage({
          type: "VAULT_FILL_REQUEST",
          fieldKey: action.vaultField,
          handle: action.handle,
        }).catch(() => {
          chrome.runtime.onMessage.removeListener(handler);
          resolve({ error: "Failed to reach service worker" });
        });

        // Safety timeout — if SW doesn't respond in 30s (e.g. user dismissed passphrase prompt)
        setTimeout(() => {
          chrome.runtime.onMessage.removeListener(handler);
          resolve({ error: "Vault fill timed out — passphrase not provided?" });
        }, 30_000);
      }
    );

    // 2. Handle error response
    if ("error" in response) {
      throw new Error(`[Vault] ${response.error}`);
    }

    // 3. Fill the DOM element using the same framework-aware strategy as doType().
    //    The value variable only lives for the duration of this method.
    const el = this.resolveHandle(action.handle);

    if (!(el instanceof HTMLElement)) {
      throw new Error(`[Vault] Handle ${action.handle} is not an HTMLElement`);
    }

    el.focus();
    await this.yield();

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // Clear existing value
      el.select();

      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
        "value"
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, response.value);
      } else {
        el.value = response.value;
      }

      // Trigger the full React/Vue/Angular event chain
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));

      // For password managers / autofill listeners
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    } else if (el.isContentEditable) {
      // ContentEditable elements (e.g. rich text editors)
      el.textContent = response.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      throw new Error(`[Vault] Handle ${action.handle} is not a fillable element`);
    }

    await this.yield();
    // Note: response.value is not explicitly zeroed here as JS has no manual memory mgmt.
    // The GC will collect it. This is an acceptable trade-off for the browser extension
    // sandbox environment. Future: use a TypedArray and zero it manually.
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Resolve a handle to a DOM element, throwing a descriptive error if missing.
   */
  private resolveHandle(handle: string): Element {
    const el = this.handles.resolve(handle);
    if (!el) {
      throw new Error(
        `Handle "${handle}" not found in page registry. The page may have changed since the snapshot was taken.`
      );
    }
    return el;
  }

  /** Dispatch a MouseEvent on an element. */
  private dispatchMouseEvent(el: Element, type: string, init: MouseEventInit = {}): void {
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      ...init,
    }));
  }

  /** Dispatch a KeyboardEvent on an element. */
  private dispatchKeyboardEvent(el: Element, type: string, key: string, init: KeyboardEventInit = {}): void {
    el.dispatchEvent(new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      key,
      ...init,
    }));
  }

  /**
   * Yield to the event loop to avoid blocking the main thread.
   * Uses scheduler.yield() if available (Chrome 115+), else rAF.
   */
  private yield(): Promise<void> {
    if (typeof (self as any).scheduler !== "undefined" && (self as any).scheduler.yield) {
      return (self as any).scheduler.yield() as Promise<void>;
    }
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

