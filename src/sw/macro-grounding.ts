import type { AgentAction, PageSnapshot } from "@shared/types.js";

/** Recorded handle IDs are ephemeral. Only explicit, unique labels can be rebound. */
export function groundMacroActions(actions: AgentAction[], snapshot: PageSnapshot): AgentAction[] {
  return actions.map(action => {
    if (!("handle" in action) || !action.handle) return action;
    if (action.type !== "click" || !action.label?.trim()) throw new Error("This macro has targets that need to be recorded again. Use direct commands for its form fields.");
    const label = action.label.trim().toLowerCase();
    const matches = snapshot.elements.filter(element => element.label?.trim().toLowerCase() === label);
    if (matches.length !== 1) throw new Error("The macro target is missing or ambiguous on this page.");
    return { ...action, handle: matches[0]!.handle, label: matches[0]!.label! };
  });
}
