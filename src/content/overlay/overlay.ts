/**
 * @file src/content/overlay/overlay.ts
 * @description Shadow-root overlay manager for VoxPilot.
 *
 * All visual indicators injected into the page (badges, highlights,
 * listening indicator, confirmation prompts) live inside a CLOSED shadow root
 * attached to a host element that VoxPilot owns.
 *
 * Security properties (SRS NFR-REL-04, NFR-REL-05):
 * - Closed shadow root: page scripts cannot access extension UI via .shadowRoot
 * - No data-* attributes written to page DOM (SRS finding #9)
 * - Overlay does not cause layout shift (position:fixed, pointer-events:none by default)
 * - Extension CSS is fully isolated from page CSS (shadow DOM boundary)
 */

import type { ElementHandle, AgentPlan } from "@shared/types.js";
import { BadgeRenderer } from "./badges.js";
import { ConfirmationDialog } from "./confirmation.js";

/** Host element ID in the page DOM (the only VoxPilot footprint on the page). */
const HOST_ID = "__voxpilot_overlay__";

/** Highlight color per SRS (hex #2563eb = Tailwind blue-600). */
const HIGHLIGHT_COLOR = "#2563eb";

/** Listening indicator states. */
const STATE_ICONS: Partial<Record<string, string>> = {
  Idle: "🎙️",
  Listening: "🔴",
  Transcribing: "⏳",
  Routing: "🔍",
  Planning: "🤔",
  Confirming: "❓",
  Executing: "⚡",
  Speaking: "🔊",
  Error: "❌",
};

/**
 * OverlayManager creates and manages the closed shadow DOM overlay.
 * Instantiated once per content script lifecycle.
 */
export class OverlayManager {
  private shadowRoot: ShadowRoot | null = null;
  private hostEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private highlightEls: Map<string, HTMLElement> = new Map();

  private readonly badges: BadgeRenderer;
  private readonly confirmation: ConfirmationDialog;

  constructor() {
    this.ensureOverlay();
    this.badges = new BadgeRenderer(this.shadowRoot!);
    this.confirmation = new ConfirmationDialog(this.shadowRoot!);
  }

  // ─── Overlay Lifecycle ────────────────────────────────────────────────────

  /**
   * Create the shadow root host element if it doesn't exist yet.
   * Safe to call multiple times (idempotent).
   */
  private ensureOverlay(): void {
    if (this.shadowRoot) return;

    // Remove any stale host (e.g., after extension update)
    document.getElementById(HOST_ID)?.remove();

    this.hostEl = document.createElement("div");
    this.hostEl.id = HOST_ID;

    // Host is a fixed-position transparent container — no layout shift
    Object.assign(this.hostEl.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      zIndex: "2147483647", // Maximum z-index
      pointerEvents: "none",
      overflow: "visible",
    });

    document.documentElement.appendChild(this.hostEl);

    // Closed shadow root prevents page script access
    this.shadowRoot = this.hostEl.attachShadow({ mode: "closed" });

    // Inject base styles
    const style = document.createElement("style");
    style.textContent = this.getBaseStyles();
    this.shadowRoot.appendChild(style);

    // Status indicator
    this.statusEl = document.createElement("div");
    this.statusEl.id = "vp-status";
    this.statusEl.setAttribute("aria-live", "polite");
    this.statusEl.setAttribute("aria-label", "VoxPilot status");
    this.shadowRoot.appendChild(this.statusEl);
  }

  // ─── Status Indicator ────────────────────────────────────────────────────

  /**
   * Update the status indicator to reflect the current agent state.
   * Per SRS IR-UI-03: state must differ by icon AND text, not colour alone.
   *
   * @param state - Current AgentState string.
   */
  setListeningState(state: string): void {
    this.ensureOverlay();
    if (!this.statusEl) return;

    const icon = STATE_ICONS[state] ?? "●";
    const isActive = state !== "Idle";

    this.statusEl.textContent = `${icon} ${state}`;
    this.statusEl.style.display = isActive ? "flex" : "none";
    this.statusEl.style.pointerEvents = "none";
  }

  // ─── SOM Badges ─────────────────────────────────────────────────────────

  /**
   * Render numbered Set-of-Marks badges over all snapshot elements.
   *
   * @param elements - Elements from the current page snapshot.
   */
  showBadges(elements: ElementHandle[]): void {
    this.ensureOverlay();
    this.badges.render(elements);
  }

  /** Remove all SOM badges. */
  hideBadges(): void {
    this.badges.clear();
  }

  // ─── Element Highlight ───────────────────────────────────────────────────

  /**
   * Draw a highlight outline around the element being acted on.
   * Per SRS IR-UI-02: #2563eb outline, ≥3px, animated unless prefers-reduced-motion.
   *
   * @param handle - Element handle to highlight.
   */
  highlightElement(handle: string): void {
    this.ensureOverlay();
    this.clearHighlights();

    // We receive a DOMRect via snapshot, but we also need live position for highlights
    // The page agent will request a fresh position from the content script
    // For now, the highlight is drawn at the last known rect position
    const highlightEl = document.createElement("div");
    highlightEl.className = "vp-highlight";
    highlightEl.setAttribute("data-handle", handle);
    this.shadowRoot?.appendChild(highlightEl);
    this.highlightEls.set(handle, highlightEl);

    // Auto-remove after 200ms per SRS IR-UI-02
    setTimeout(() => {
      highlightEl.remove();
      this.highlightEls.delete(handle);
    }, 200);
  }

  /**
   * Position a highlight overlay at the given DOMRect coordinates.
   * Called after resolving the element's current screen position.
   *
   * @param handle - Handle string.
   * @param rect   - Current bounding rect of the element.
   */
  positionHighlight(handle: string, rect: DOMRect): void {
    const el = this.highlightEls.get(handle);
    if (!el) return;

    Object.assign(el.style, {
      position: "fixed",
      top: `${rect.top - 3}px`,
      left: `${rect.left - 3}px`,
      width: `${rect.width + 6}px`,
      height: `${rect.height + 6}px`,
      pointerEvents: "none",
      display: "block",
    });
  }

  private clearHighlights(): void {
    for (const el of this.highlightEls.values()) {
      el.remove();
    }
    this.highlightEls.clear();
  }

  // ─── Confirmation Dialog ─────────────────────────────────────────────────

  /**
   * Show a confirmation dialog for a high-risk plan (R3/R4).
   * Returns a Promise that resolves when the user confirms or cancels.
   *
   * Per SRS IR-UI-05: role=alertdialog, focus-trapped, keyboard operable,
   * announced to screen readers.
   *
   * @param plan - The plan awaiting confirmation.
   * @returns true if confirmed, false if cancelled.
   */
  async showConfirmation(plan: AgentPlan): Promise<boolean> {
    this.ensureOverlay();
    return this.confirmation.show(plan);
  }

  // ─── Teardown ────────────────────────────────────────────────────────────

  /** Remove the overlay from the page completely. */
  destroy(): void {
    this.hostEl?.remove();
    this.hostEl = null;
    this.shadowRoot = null;
    this.statusEl = null;
    this.highlightEls.clear();
  }

  // ─── Styles ─────────────────────────────────────────────────────────────

  private getBaseStyles(): string {
    return `
      :host {
        all: initial;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        z-index: 2147483647 !important;
      }

      #vp-status {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: rgba(15, 23, 42, 0.92);
        color: #f1f5f9;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        font-weight: 500;
        padding: 6px 12px;
        border-radius: 20px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        pointer-events: none;
        display: none;
        align-items: center;
        gap: 6px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(8px);
        z-index: 2147483647;
      }

      .vp-highlight {
        position: fixed;
        outline: 3px solid ${HIGHLIGHT_COLOR};
        outline-offset: 2px;
        border-radius: 3px;
        pointer-events: none;
        z-index: 2147483646;
        animation: vp-highlight-pulse 0.2s ease-out;
      }

      @media (prefers-reduced-motion: reduce) {
        .vp-highlight {
          animation: none;
        }
      }

      @keyframes vp-highlight-pulse {
        from { opacity: 0.4; transform: scale(1.05); }
        to   { opacity: 1;   transform: scale(1); }
      }
    `;
  }
}

