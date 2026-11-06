/**
 * @file src/content/snapshot.ts
 * @description DOM snapshot builder for VoxPilot.
 *
 * Produces a compact, structured description of the actionable elements on the
 * current page — used by the LLM for grounding action targets.
 *
 * Performance target (SRS NFR-PERF-08):
 * - ≤ 50 ms at p50 for a page with 5,000 DOM nodes
 * - Must not block the page main thread for more than 16 ms in one slice
 *
 * Security:
 * - Page content treated as UNTRUSTED (prompt-injection risk).
 * - Sensitive field values (passwords) are excluded from snapshots.
 * - Snapshot text is escaped when embedded in LLM prompts (see planner.ts).
 */

import { HandleRegistry } from "./handles.js";
import type { ElementHandle, PageSnapshot } from "@shared/types.js";

/** Maximum number of elements in a single snapshot (prevents prompt overflow). */
const MAX_ELEMENTS = 150;

/**
 * CSS selector that matches all actionable elements.
 * Ordered from most to least common for fast short-circuit.
 */
const ACTIONABLE_SELECTOR = [
  "input:not([type='hidden']):not([disabled])",
  "button:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[role='button']:not([disabled])",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[role='combobox']",
  "[role='searchbox']",
  "[role='textbox']",
  "[contenteditable='true']",
  "[contenteditable='']",
].join(", ");

/** Implicit ARIA roles for common HTML elements. */
const IMPLICIT_ROLES: Record<string, string> = {
  button: "button",
  a: "link",
  input: "textbox",
  select: "combobox",
  textarea: "textbox",
  h1: "heading",
  h2: "heading",
  h3: "heading",
};

/**
 * Extract a human-readable label from a DOM element.
 * Priority: aria-label > aria-labelledby > associated <label> > placeholder > text content.
 */
function extractLabel(el: Element): string | undefined {
  // 1. aria-label
  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel.slice(0, 100);

  // 2. aria-labelledby
  const labelledById = el.getAttribute("aria-labelledby");
  if (labelledById) {
    const labelEl = document.getElementById(labelledById);
    const text = labelEl?.textContent?.trim();
    if (text) return text.slice(0, 100);
  }

  // 3. Associated <label> element (via id)
  const id = el.getAttribute("id");
  if (id) {
    const labelEl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    const text = labelEl?.textContent?.trim();
    if (text) return text.slice(0, 100);
  }

  // 4. Placeholder
  const placeholder = (el as HTMLInputElement).placeholder?.trim();
  if (placeholder) return placeholder.slice(0, 100);

  // 5. Text content (buttons, links — truncated)
  const textContent = el.textContent?.trim().replace(/\s+/g, " ");
  if (textContent && textContent.length > 0) return textContent.slice(0, 100);

  // 6. title attribute
  const title = el.getAttribute("title")?.trim();
  if (title) return title.slice(0, 100);

  return undefined;
}

/**
 * Determine if an element is visible in the current viewport.
 * Uses getBoundingClientRect for speed (no layout thrashing on individual elements
 * since we batch the query).
 */
function isInViewport(rect: DOMRect): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  );
}

/**
 * Check if an element is effectively hidden (display:none, visibility:hidden, opacity:0).
 * Faster than getComputedStyle on every element — only called on visible-rect elements.
 */
function isEffectivelyHidden(el: Element): boolean {
  // Cheap checks first
  if ((el as HTMLElement).hidden) return true;
  const style = (el as HTMLElement).style;
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return true;
  // Full computed style (more expensive — only reached if cheap checks pass)
  const computed = window.getComputedStyle(el);
  return computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0";
}

/**
 * SnapshotBuilder produces a PageSnapshot from the current page DOM.
 * Instantiated once per content script; call build() on each command.
 */
export class SnapshotBuilder {
  /** The handle registry — shared with ActionExecutor. */
  readonly handles: HandleRegistry = new HandleRegistry();

  /**
   * Build a snapshot of the current page.
   *
   * Performance: Runs synchronously. For pages with > MAX_ELEMENTS interactive
   * elements, only viewport-visible elements are included.
   *
   * @returns PageSnapshot — compact representation of actionable elements.
   */
  build(): PageSnapshot {
    const startMs = performance.now();

    // Reset handle registry for this snapshot cycle
    this.handles.reset();

    // Query all candidate elements
    const candidates = Array.from(document.querySelectorAll<Element>(ACTIONABLE_SELECTOR));

    // Batch getBoundingClientRect calls to avoid forced reflows
    const rects = candidates.map((el) => el.getBoundingClientRect());

    const elements: ElementHandle[] = [];
    let truncated = false;

    for (let i = 0; i < candidates.length; i++) {
      if (elements.length >= MAX_ELEMENTS) {
        truncated = true;
        break;
      }

      const el = candidates[i]!;
      const rect = rects[i]!;

      // Skip zero-size or hidden elements
      if (rect.width === 0 || rect.height === 0) continue;
      if (isEffectivelyHidden(el)) continue;

      const inViewport = isInViewport(rect);

      // If we have many candidates, prefer viewport-visible ones
      if (!inViewport && candidates.length > MAX_ELEMENTS * 2) continue;

      const tag = el.tagName.toLowerCase();
      const inputType = tag === "input" ? (el as HTMLInputElement).type?.toLowerCase() : undefined;

      // Exclude password fields from snapshot values (security)
      const isSensitive = inputType === "password";
      const rawValue = !isSensitive
        ? (("value" in el ? (el as HTMLInputElement).value : el.textContent) ?? "")
        : undefined;
      const value = rawValue?.trim().slice(0, 100) || undefined;

      const role =
        el.getAttribute("role") ??
        IMPLICIT_ROLES[tag] ??
        undefined;

      const handle = this.handles.register(el);

      elements.push({
        handle,
        tag,
        ...(inputType && { inputType }),
        ...(role && { role }),
        label: extractLabel(el),
        ...(value && { value }),
        disabled: (el as HTMLInputElement).disabled ?? false,
        inViewport,
        rect,
      });
    }

    const elapsed = performance.now() - startMs;
    if (elapsed > 50) {
      console.warn(`[VoxPilot snapshot] Built in ${elapsed.toFixed(1)}ms (target: ≤50ms) with ${elements.length} elements`);
    }

    return {
      url: window.location.href,
      title: document.title,
      elements,
      capturedAt: Date.now(),
      truncated,
    };
  }
}

