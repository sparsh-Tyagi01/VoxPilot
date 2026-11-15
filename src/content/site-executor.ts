import type { SiteAction, SiteStepResult } from "@shared/site-task.js";
import type { SnapshotBuilder } from "./snapshot.js";
import { describeSiteTarget } from "./site-observation.js";
import { ActionExecutor } from "./executor.js";

/** One grounded interaction. Navigation is executed by the privileged coordinator. */
export async function executeSiteAction(builder: SnapshotBuilder, action: SiteAction, documentId: string, fingerprint: string): Promise<SiteStepResult> {
  if (builder.documentId !== documentId) throw new Error("The page changed. Start again on the current page.");
  if (action.type === "navigate") throw new Error("Navigation belongs to the coordinator.");
  const el = "handle" in action && action.handle ? builder.handles.resolve(action.handle) : null;
  if ("handle" in action && action.handle) {
    if (!el?.isConnected || describeSiteTarget(el, builder.handles).fingerprint !== fingerprint) throw new Error("The target or its details changed. Repeat the request with fresh page context.");
    if ((el as HTMLInputElement).disabled || el.getAttribute("aria-disabled") === "true") throw new Error("The target is disabled.");
  }
  if (action.type === "click") {
    if (!(el instanceof HTMLElement)) throw new Error("This control cannot be clicked by the extension.");
    // Native activation once; no synthetic click chain and no wait after navigation.
    el.click();
    return { dispatched: true, controlVerified: false, navigationExpected: el instanceof HTMLAnchorElement || (el instanceof HTMLButtonElement && el.type === "submit") };
  }
  if (action.type === "submit") {
    if (!(el instanceof HTMLFormElement)) throw new Error("A form reference is required for submission.");
    if (!el.checkValidity()) throw new Error("The form has missing or invalid required fields.");
    el.requestSubmit();
    return { dispatched: true, controlVerified: false, navigationExpected: true };
  }
  await new ActionExecutor(builder.handles).executeAction(action);
  let controlVerified = false;
  if (action.type === "type") controlVerified = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value === action.text : el instanceof HTMLElement && el.textContent === action.text;
  if (action.type === "select" && el instanceof HTMLSelectElement) controlVerified = Array.from(el.selectedOptions).some(option => option.text.trim().toLowerCase() === action.option.trim().toLowerCase() || option.value === action.option);
  if (action.type === "toggle" && el instanceof HTMLInputElement) controlVerified = el.checked === action.checked;
  if (action.type === "read" || action.type === "scroll") controlVerified = true;
  return { dispatched: true, controlVerified, navigationExpected: false };
}
