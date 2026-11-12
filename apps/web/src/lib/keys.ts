/** True when a key press belongs to whatever has focus, so shortcuts should stay out of it. */
export function isTyping(event: KeyboardEvent, includeButtons = false): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  const el = event.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  // Sliders and checkboxes are inputs too, but they don't take text.
  if (tag === 'INPUT') return includeButtons || !['range', 'checkbox', 'radio'].includes((el as HTMLInputElement).type);
  return includeButtons && (tag === 'BUTTON' || tag === 'A');
}
