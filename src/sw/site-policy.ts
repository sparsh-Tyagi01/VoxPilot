import type { SiteAction, SiteObservation } from "@shared/site-task.js";
export interface SitePolicyResult { allowed: boolean; approval: boolean; reason: string; fingerprint: string; description: string; context: string; destination: string; }
const normalized = (text: string) => text.replace(/\s+/g, " ").trim();
/** Unqualified commitment flows remain manual; a model cannot lower this floor. */
function manualCommitment(label: string, destination = ""): boolean {
  let pathname = "";
  try { pathname = decodeURIComponent(new URL(destination).pathname); } catch { /* No destination. */ }
  return /^(?:buy\s+now|place\s+(?:the\s+)?order|pay(?:\s|$)|checkout|delete(?:\s|$)|remove(?:\s|$)|send(?:\s|$)|publish(?:\s|$)|subscribe(?:\s|$)|transfer(?:\s|$)|confirm\s+(?:payment|purchase|deletion))/i.test(label.trim())
    || /\/(?:checkout|payment|purchase|delete|remove|transfer|subscribe)(?:\/|$)/i.test(pathname);
}
export function checkSitePolicy(action: SiteAction, observation: SiteObservation, origin: string): SitePolicyResult {
  const result: SitePolicyResult = { allowed: true, approval: false, reason: "", fingerprint: "", description: action.type, context: "", destination: origin };
  const deny = (reason: string): SitePolicyResult => ({ ...result, allowed: false, reason });
  if (new URL(observation.url).origin !== origin) return deny("The site changed. Start a new request on this site.");
  if (action.type === "navigate") {
    let url: URL;
    try { url = new URL(action.url); } catch { return deny("The destination is invalid."); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.origin !== origin) return deny("This task cannot navigate to another origin. Open that site and start a new request.");
    if (!observation.elements.some(el => el.href === url.href)) return deny("The destination was not observed on this page.");
    if (manualCommitment(observation.elements.find(el => el.href === url.href)?.label ?? "", url.href)) return deny("Complete this commitment step directly on the site. Automated payment, sending and destructive flows are not qualified yet.");
    return { ...result, description: `Open ${url.href}`, destination: url.href };
  }
  if ((action.type === "scroll" || action.type === "read") && !action.handle) return result;
  const target = "handle" in action ? observation.elements.find(el => el.handle === action.handle) : undefined;
  const form = action.type === "submit" ? observation.forms.find(item => item.handle === action.handle) : target?.formHandle ? observation.forms.find(item => item.handle === target.formHandle) : undefined;
  if (action.type === "submit") {
    if (!form) return deny("The form is not part of the current observation.");
    if (form.limited) return deny("This form has more controls than could be safely inspected. Submit it manually.");
    result.fingerprint = form.fingerprint;
    result.destination = form.action;
    result.description = form.search ? "Submit this site's search" : "Submit the selected form";
    result.context = form.fields.map(field => field.name || field.type).join(", ").slice(0, 600);
    if (manualCommitment("", form.action) || form.submitLabels?.some(label => manualCommitment(label))) return deny("Complete this payment, sending or account-change form directly on the site.");
    const safeSearch = form.search && form.fields.length < 80 && form.method === "get" && new URL(form.action).origin === origin && !form.fields.some(field => field.sensitive || (field.populated && !["search", "submit", "button"].includes(field.type)));
    result.approval = !safeSearch;
    if (new URL(form.action).origin !== origin) return deny("This form sends information to another origin. Complete it manually.");
    return result;
  }
  if (!target) return deny("The target is missing from the current observation.");
  if (form?.limited && !["read", "scroll"].includes(action.type)) return deny("This form exceeds safe inspection limits. Complete this step manually.");
  result.fingerprint = target.fingerprint;
  result.context = target.context;
  result.description = `${action.type === "type" ? "Fill" : action.type === "click" ? "Activate" : action.type} ${normalized(target.label || target.tag).slice(0, 150)}`;
  if (["click", "toggle"].includes(action.type) && manualCommitment(target.label ?? "", target.href)) return deny("Complete this commitment step directly on the site. Automated payment, sending and destructive flows are not qualified yet.");
  if (target.disabled || (action.type === "type" && target.readOnly)) return deny("This control is disabled or read-only.");
  if (action.type === "type") {
    if (/password|file/.test(target.inputType ?? "") || /password|card number|cvv|security code|one.time.code/i.test(target.label ?? "")) return deny("Use the site's secure manual flow or your vault for this field.");
    if (!["input", "textarea"].includes(target.tag) && target.role !== "textbox") return deny("This target is not a supported editable field.");
    result.approval = Boolean(form?.fields.some(field => field.sensitive)) || /email|tel/.test(target.inputType ?? "");
    if (form && new URL(form.action).origin !== origin) return deny("This field belongs to a form on another origin. Complete it manually.");
  } else if (action.type === "click") {
    if (target.href) {
      const url = new URL(target.href);
      if (!/^https?:$/.test(url.protocol) || url.origin !== origin || url.username || url.password) return deny("Open the other site explicitly before asking the agent to act there.");
      result.destination = url.href;
    } else result.approval = true; // Unknown effects include cart, send, purchase and account changes.
  } else if (action.type === "select" || action.type === "toggle") result.approval = action.type === "toggle" || Boolean(form?.fields.some(field => field.sensitive));
  return result;
}
export function visibleSiteText(observation: SiteObservation): string {
  return normalized([observation.title, ...(observation.headings ?? []), observation.textSummary ?? "", ...observation.elements.map(el => `${el.label ?? ""} ${el.context}`)].join(" "));
}
export function siteChanged(before: SiteObservation, after: SiteObservation): boolean {
  return before.url !== after.url || visibleSiteText(before) !== visibleSiteText(after);
}
