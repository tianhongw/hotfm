import { useEffect } from 'react'
import { seek, toggleFavorite, togglePlay } from '../player/controller'
import { nudge } from '../player/tuning'
import { useLibrary } from '../stores/library'
import { useUI } from '../stores/ui'

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

/** Global shortcuts; components with their own key handling (dial, knob) stop propagation. */
export function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey) return
      const ui = useUI.getState()
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (ui.shortcutsOpen || ui.locationOpen || ui.appearanceOpen || ui.sheetOpen) return
        ui.focusSearch()
        return
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey) return
      if (ui.shortcutsOpen || ui.locationOpen || ui.appearanceOpen || ui.sheetOpen) return
      const lib = useLibrary.getState()
      // Fine tuning reveals the dial so the needle is visible.
      const tune = (d: number) => {
        ui.setDialOpen(true)
        if (window.matchMedia('(max-width: 767px)').matches) ui.setSheetOpen(true)
        nudge(d)
      }
      const handlers: Record<string, () => void> = {
        ' ': () => togglePlay(),
        ArrowLeft: () => (e.shiftKey ? seek(-1) : tune(-0.1)),
        ArrowRight: () => (e.shiftKey ? seek(1) : tune(0.1)),
        ArrowUp: () => lib.setVolume(lib.volume + 0.05),
        ArrowDown: () => lib.setVolume(lib.volume - 0.05),
        m: () => lib.setMuted(!lib.muted),
        f: () => toggleFavorite(),
        '/': () => ui.focusSearch(),
        '?': () => ui.setShortcutsOpen(true),
        t: () => ui.setDialOpen(!ui.dialOpen),
        l: () => {
          ui.setTab('all')
          ui.setLocationOpen(true)
        },
      }
      const fn = handlers[e.key.length === 1 ? e.key.toLowerCase() : e.key]
      if (!fn) return
      // Let a focused button handle Space/Enter itself.
      if (e.key === ' ' && (e.target as HTMLElement)?.closest('button, [role="slider"]')) return
      e.preventDefault()
      fn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
