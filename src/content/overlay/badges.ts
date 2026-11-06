/**
 * @file src/content/overlay/badges.ts
 * @description Set-of-Marks (SOM) badge renderer for VoxPilot.
 *
 * Renders numbered badges over interactive page elements so the LLM can refer
 * to them by number. Badges live in the closed shadow root — never in page DOM.
 *
 * SRS requirements:
 * - IR-UI-06: Badges ≥16px, ≥4.5:1 contrast, no overlap, don't obstruct target label
 * - FR-DOM-03: Badges in isolated shadow root; id map held in content script only
 */

import type { ElementHandle } from "@shared/types.js";

/** Minimum badge size in px (SRS IR-UI-06). */
const BADGE_SIZE = 20;

/** Badge background color. */
const BADGE_BG = "#2563eb";      // blue-600, AAA contrast on white text
const BADGE_FG = "#ffffff";

/**
 * BadgeRenderer renders and removes numbered overlay badges.
 * All badge elements live inside the provided shadow root.
 */
export class BadgeRenderer {
  private container: HTMLElement;
  private badgeEls: HTMLElement[] = [];

  private readonly root: ShadowRoot;

  constructor(shadowRoot: ShadowRoot) {
    this.root = shadowRoot;
    // Inject badge styles
    const style = document.createElement("style");
    style.textContent = this.getBadgeStyles();
    this.root.appendChild(style);

    // Container for all badges
    this.container = document.createElement("div");
    this.container.id = "vp-badges";
    shadowRoot.appendChild(this.container);
  }

  /**
   * Render badges for all provided elements.
   * Existing badges are cleared first.
   *
   * @param elements - Snapshot elements to badge.
   */
  render(elements: ElementHandle[]): void {
    this.clear();

    for (const el of elements) {
      if (!el.rect || !el.inViewport) continue;
      this.createBadge(el);
    }
  }

  /**
   * Create a single badge for an element.
   */
  private createBadge(el: ElementHandle): void {
    const rect = el.rect!;

    const badge = document.createElement("div");
    badge.className = "vp-badge";
    badge.textContent = el.handle.replace("e", ""); // Show number only
    badge.setAttribute("aria-hidden", "true");
    badge.setAttribute("title", el.label ?? el.handle);

    // Position at top-left of element, offset to avoid covering label
    Object.assign(badge.style, {
      position: "fixed",
      top: `${Math.max(0, rect.top - BADGE_SIZE / 2)}px`,
      left: `${Math.max(0, rect.left - BADGE_SIZE / 2)}px`,
      zIndex: "2147483646",
    });

    this.container.appendChild(badge);
    this.badgeEls.push(badge);
  }

  /** Remove all rendered badges. */
  clear(): void {
    for (const el of this.badgeEls) {
      el.remove();
    }
    this.badgeEls = [];
  }

  private getBadgeStyles(): string {
    return `
      .vp-badge {
        position: fixed;
        width: ${BADGE_SIZE}px;
        height: ${BADGE_SIZE}px;
        min-width: ${BADGE_SIZE}px;
        background: ${BADGE_BG};
        color: ${BADGE_FG};
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace;
        font-size: 11px;
        font-weight: 700;
        line-height: ${BADGE_SIZE}px;
        text-align: center;
        border-radius: 50%;
        border: 2px solid #fff;
        pointer-events: none;
        box-shadow: 0 1px 4px rgba(0,0,0,0.4);
        user-select: none;
        z-index: 2147483646;
      }
    `;
  }
}

