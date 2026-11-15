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

import { SNAPSHOT_TIMEOUT_MS } from "@shared/constants.js";
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
export function extractLabel(el: Element): string | undefined {
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

  // Native labels avoids repeated document-wide selector queries for form fields.
  if ("labels" in el) {
    const labels = (el as HTMLInputElement).labels;
    const text = labels?.[0]?.textContent?.trim();
    if (text) return text.slice(0, 100);
  }

  // 3. Associated <label> element (via id)
  const id = el.getAttribute("id");
  if (id && !("labels" in el)) {
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
  readonly documentId = crypto.randomUUID();
  private candidates: Element[] | null = null;
  private revision = 0;
  private readonly observer = new MutationObserver(() => { this.candidates = null; this.revision++; });
  constructor() {
    this.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  dispose(): void { this.observer.disconnect(); this.candidates = null; }


  /**
   * Build a snapshot of the current page.
   *
   * Performance: Runs synchronously. For pages with > MAX_ELEMENTS interactive
   * elements, only viewport-visible elements are included.
   *
   * @returns PageSnapshot — compact representation of actionable elements.
   */
  build(includeText = true): PageSnapshot {
    const startMs = performance.now();
    // Leave room for headings, readable text, and serialization metadata.
    const elementDeadline = startMs + Math.max(1, SNAPSHOT_TIMEOUT_MS - 10);

    // Reset handle registry for this snapshot cycle
    this.handles.reset();

    // Query all candidate elements
    if (this.observer.takeRecords().length) { this.candidates = null; this.revision++; }
    this.candidates ??= Array.from(document.querySelectorAll<Element>(ACTIONABLE_SELECTOR));
    const candidates = this.candidates;

    const elements: ElementHandle[] = [];
    let truncated = false;

    for (let i = 0; i < candidates.length; i++) {
      if (elements.length >= MAX_ELEMENTS || performance.now() >= elementDeadline) {
        truncated = true;
        break;
      }

      const el = candidates[i]!;
      const rect = el.getBoundingClientRect();

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
        label: extractLabel(el) ?? "",
        ...(value && { value }),
        disabled: (el as HTMLInputElement).disabled ?? false,
        inViewport,
        rect,
      });
    }

    // Use textContent to avoid the synchronous layout calculation required by innerText.
    // Extract key headings for semantic understanding
    const headings = Array.from(includeText ? document.querySelectorAll<HTMLElement>("h1, h2, h3") : [])
      .slice(0, 15)
      .map((h) => h.textContent?.trim().slice(0, 150))
      .filter((t): t is string => Boolean(t && t.length > 2))
      .slice(0, 15);

    // Extract readable main body text
    const mainEl = includeText ? document.querySelector<HTMLElement>("main, article, [role='main'], #content, .content") || document.body : null;
    const textParts: string[] = [];
    let textLength = 0;
    if (mainEl) {
      const walker = document.createTreeWalker(mainEl, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      let visited = 0;
      while (performance.now() - startMs < SNAPSHOT_TIMEOUT_MS && textLength < 2500 && visited++ < 2000 && (node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest("script, style, noscript, template, [hidden], [aria-hidden='true']")) continue;
        const text = node.textContent?.replace(/\s+/g, " ").trim().slice(0, 2500 - textLength);
        if (text) { textParts.push(text); textLength += text.length + 1; }
      }
    }
    const textSummary = textParts.join(" ").slice(0, 2500);

    const elapsed = performance.now() - startMs;
    // Tiny scheduling overruns at the deadline are normal; retain diagnostics.
    if (elapsed > SNAPSHOT_TIMEOUT_MS + 5) {
      console.warn(`[VoxPilot snapshot] Built in ${elapsed.toFixed(1)}ms with ${elements.length} elements (budget ${SNAPSHOT_TIMEOUT_MS}ms)`);
    }

    return {
      documentId: this.documentId, revision: this.revision,
      url: window.location.href,
      title: document.title,
      elements,
      headings,
      textSummary,
      capturedAt: Date.now(),
      truncated,
    };
  }
}

