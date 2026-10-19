import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import s from './Dialog.module.css'

/**
 * Modal overlay with focus trap-lite (focus on open, restore on close) and Escape to close.
 * `sheet` docks to the bottom and `full` covers the screen — both meant for phones.
 */
export function Dialog({
  open,
  onClose,
  label,
  children,
  variant = 'center',
}: {
  open: boolean
  onClose: () => void
  label: string
  children: ReactNode
  variant?: 'center' | 'top' | 'sheet' | 'full'
}) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const app = document.getElementById('root')
    const wasInert = app?.inert ?? false
    if (app) app.inert = true
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close.current()
      }
      if (e.key === 'Tab' && panel.current) {
        const items = Array.from(
          panel.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
          ),
        ).filter((el) => el.getClientRects().length > 0)
        const first = items[0]
        const last = items[items.length - 1]
        if (!first) {
          e.preventDefault()
          panel.current.focus()
        } else if (e.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    const t = window.setTimeout(() => {
      const target = panel.current?.querySelector<HTMLElement>('[autofocus], input, button')
      target?.focus()
    })
    return () => {
      document.removeEventListener('keydown', onKey)
      window.clearTimeout(t)
      if (app) app.inert = wasInert
      document.body.style.overflow = previousOverflow
      if (prev?.isConnected) prev.focus()
    }
  }, [open])
  if (!open) return null
  return createPortal(
    <div className={s.backdrop} data-variant={variant} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} tabIndex={-1} className={s.panel} data-variant={variant} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  )
}
