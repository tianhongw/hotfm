/** Regions that consume arrow keys themselves: list panels, menus, listboxes, radio groups, sliders and dialogs. */
const ARROW_OWNERS =
  '#station-panel, dialog, [role="dialog"], [role="menu"], [role="menubar"], [role="listbox"], [role="radiogroup"], [role="slider"]'

/**
 * True when the focused element (or an ancestor) needs ↑/↓ for its own
 * navigation, so the global volume shortcuts must stand down.
 */
export function ownsArrowKeys(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  if (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el.closest?.(ARROW_OWNERS) != null
}