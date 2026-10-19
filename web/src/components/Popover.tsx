import { useEffect, useRef, type ReactNode } from 'react'
import s from './Popover.module.css'

/** Minimal anchored popover that closes on outside click or Escape. */
export function Popover({
  open,
  onClose,
  children,
  align = 'right',
  placement = 'bottom',
  role = 'menu',
  label,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  align?: 'left' | 'right' | 'center'
  placement?: 'top' | 'bottom'
  role?: 'menu' | 'dialog'
  label?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div ref={ref} className={s.pop} data-align={align} data-placement={placement} role={role} aria-label={label}>
      {children}
    </div>
  )
}

export function MenuItem({ children, onClick, active }: { children: ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button role="menuitem" className={s.item} data-active={active || undefined} onClick={onClick}>
      {children}
    </button>
  )
}
