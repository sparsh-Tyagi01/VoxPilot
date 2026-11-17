/** Read page prose without editable contents, scripts, or explicitly hidden text. */
export const PRIVATE_TEXT_SELECTOR = "script, style, noscript, template, [hidden], [aria-hidden='true'], [inert], input, textarea, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='searchbox']";
export function isPublicTextElement(el: Element): boolean {
  if (el.closest(PRIVATE_TEXT_SELECTOR)) return false;
  if (typeof el.checkVisibility === "function") {
    if (el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
    // display:contents has visible text without a box of its own.
    const style = window.getComputedStyle(el);
    return style.display === "contents" && style.visibility !== "hidden" && style.visibility !== "collapse" && style.opacity !== "0"
      && Boolean(el.parentElement && isPublicTextElement(el.parentElement));
  }
  for (let parent: Element | null = el; parent; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0" || style.contentVisibility === "hidden") return false;
  }
  return true;
}
export function publicText(root: Node, limit: number): string {
  if (root instanceof Element && !isPublicTextElement(root)) return "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = []; let length = 0, visited = 0; let node: Node | null;
  while (length < limit && visited++ < 2000 && (node = walker.nextNode())) {
    if (!node.parentElement || !isPublicTextElement(node.parentElement)) continue;
    const text = node.textContent?.replace(/\s+/g, " ").trim().slice(0, limit - length);
    if (text) { parts.push(text); length += text.length + 1; }
  }
  return parts.join(" ").slice(0, limit);
}
