import type { SiteElement, SiteForm, SiteObservation } from "@shared/site-task.js";
import { extractLabel, SnapshotBuilder } from "./snapshot.js";
import type { HandleRegistry } from "./handles.js";
// Private to the isolated content script. Values are never included in observations,
// model context, receipts or logs. Weak keys release the comparison state with the form.
const formVersions = new WeakMap<HTMLFormElement, { values: string; token: string }>();

export function describeForm(form: HTMLFormElement, handles: HandleRegistry): SiteForm {
  const controls = Array.from(form.elements).slice(0, 80).filter((el): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement);
  const values = JSON.stringify(controls.map(el => [el.name, el.value.slice(0, 2000), el instanceof HTMLInputElement ? el.checked : null]));
  const previous = formVersions.get(form);
  const token = previous?.values === values ? previous.token : crypto.randomUUID();
  formVersions.set(form, { values, token });
  const info = { handle: handles.register(form), action: form.action || location.href, method: form.method.toLowerCase(),
    limited: form.elements.length > 80 || controls.some(el => el.value.length > 2000),
    submitLabels: Array.from(form.querySelectorAll("button, input[type='submit'], input[type='image']")).slice(0, 20).map(el => extractLabel(el) ?? (el as HTMLInputElement).value ?? ""),
    search: form.getAttribute("role") === "search" || controls.some(el => el instanceof HTMLInputElement && el.type === "search"),
    fields: controls.filter(el => !el.disabled).map(el => ({ name: el.name.slice(0, 100), type: el.type,
      populated: Boolean(el.value), sensitive: /password|email|tel|file/.test(el.type) || /pass|card|token|secret|auth|session|csrf/i.test(el.name) || /cc-|password|one-time-code/.test(el.autocomplete) })),
  };
  return { ...info, fingerprint: JSON.stringify([token, form.elements.length, info.action, info.method, info.fields, info.submitLabels, form.textContent?.replace(/\s+/g, " ").trim().slice(0, 600)]) };
}
interface ObservationCache { forms: Map<HTMLFormElement, SiteForm>; contexts: Map<Element, string>; }
export function describeSiteTarget(el: Element, handles: HandleRegistry, cache?: ObservationCache): SiteElement {
  const input = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  const form = el instanceof HTMLFormElement ? el : "form" in el ? (el as HTMLInputElement).form : null;
  const formInfo = form ? cache?.forms.get(form) ?? describeForm(form, handles) : null;
  if (form && formInfo) cache?.forms.set(form, formInfo);
  const href = el instanceof HTMLAnchorElement ? el.href : undefined;
  const region = el.closest("[data-product-id], .product, article, [role='listitem'], tr, form") ?? el.parentElement;
  const context = region ? cache?.contexts.get(region) ?? region.textContent?.replace(/\s+/g, " ").trim().slice(0, 600) ?? "" : "";
  if (region) cache?.contexts.set(region, context);
  const label = extractLabel(el) ?? "";
  const tag = el.tagName.toLowerCase();
  const disabled = Boolean((el as HTMLInputElement).disabled || el.getAttribute("aria-disabled") === "true");
  const readOnly = Boolean((el as HTMLInputElement).readOnly);
  const inputType = input || el instanceof HTMLButtonElement ? (el as HTMLInputElement).type : undefined;
  const options = el instanceof HTMLSelectElement ? Array.from(el.options).slice(0, 40).map(option => option.text.slice(0, 100)) : undefined;
  const fingerprint = el instanceof HTMLFormElement ? formInfo!.fingerprint : JSON.stringify([tag, label, href, el.getAttribute("role"), inputType, disabled, readOnly, context, formInfo,
    el instanceof HTMLSelectElement ? el.selectedIndex : null, el instanceof HTMLInputElement && ["number", "checkbox", "radio"].includes(el.type) ? [el.value, el.checked] : null]);
  return { handle: handles.register(el), tag, label, context, fingerprint, disabled, readOnly,
    ...(inputType ? { inputType } : {}), ...(href ? { href } : {}), ...(formInfo ? { formHandle: formInfo.handle } : {}), ...(options ? { options } : {}) };
}
export function observeSite(builder: SnapshotBuilder): SiteObservation {
  const page = builder.build(true);
  const forms = new Map<string, SiteForm>();
  const cache: ObservationCache = { forms: new Map(), contexts: new Map() };
  const elements: SiteElement[] = [];
  const deadline = performance.now() + 20;
  for (const item of page.elements) {
    if (performance.now() >= deadline) break;
    const el = builder.handles.resolve(item.handle);
    if (!el?.isConnected) continue;
    const described = describeSiteTarget(el, builder.handles, cache);
    elements.push({ ...described, inViewport: item.inViewport ?? false });
    const form = "form" in el ? (el as HTMLInputElement).form : null;
    if (form) { const info = cache.forms.get(form)!; forms.set(info.handle, info); }
  }
  const text = JSON.stringify([page.url, page.title, page.textSummary, elements.map(el => [el.label, el.context])]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return { ...page, documentId: builder.documentId, observationId: crypto.randomUUID(), stateKey: (hash >>> 0).toString(36), elements, forms: [...forms.values()],
    coverage: { candidates: page.elements.length, inspected: elements.length, limited: page.truncated || elements.length < page.elements.length, frames: "top_only" } };
}
/** Event-driven, bounded settling. Rebuild once the relevant page content changes. */
export async function waitForSiteObservation(builder: SnapshotBuilder, since?: string): Promise<SiteObservation> {
  const current = observeSite(builder);
  if (!since || current.stateKey !== since) return current;
  return new Promise(resolve => {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const finish = () => { observer.disconnect(); clearTimeout(deadline); if (debounce) clearTimeout(debounce); resolve(observeSite(builder)); };
    const observer = new MutationObserver(() => { if (debounce) clearTimeout(debounce); debounce = setTimeout(finish, 100); });
    const deadline = setTimeout(finish, 4000);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  });
}
