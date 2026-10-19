import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import s from './Marquee.module.css'

/** Scrolls its content horizontally only when it does not fit. */
export function Marquee({ children, className }: { children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0)

  useLayoutEffect(() => {
    const measure = () => {
      const b = box.current
      const i = inner.current
      if (!b || !i) return
      const overflow = i.scrollWidth - b.clientWidth
      setShift(overflow > 4 ? overflow + 32 : 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (box.current) ro.observe(box.current)
    return () => ro.disconnect()
  }, [children])

  return (
    <div ref={box} className={`${s.box} ${className ?? ''}`} data-scroll={shift > 0 || undefined}>
      <span
        ref={inner}
        className={s.inner}
        style={shift ? { ['--shift' as string]: `-${shift}px`, ['--dur' as string]: `${Math.max(8, shift / 28)}s` } : undefined}
      >
        {children}
      </span>
    </div>
  )
}
