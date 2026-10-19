import { useState } from 'react'
import s from './Logo.module.css'

/** Station logo with a typographic fallback (initials on a tinted tile). */
export function Logo({ src, name, size = 40 }: { src: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  const initials = monogram(name)
  const hue = hash(name) % 360
  return (
    <span className={s.logo} style={{ width: size, height: size, ['--hue' as string]: hue }}>
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <span className={s.mono} style={{ fontSize: size * (initials.length > 1 ? 0.34 : 0.42) }}>
          {initials}
        </span>
      )}
    </span>
  )
}

function monogram(name: string): string {
  const cleaned = name.replace(/^[\s\d.\-–:|]+/, '').trim() || name
  const first = [...cleaned][0] ?? '?'
  if (/[㐀-鿿]/.test(first)) return first
  const words = cleaned.split(/[\s\-–_/]+/).filter((w) => /[A-Za-z0-9]/.test(w))
  const letters = words.slice(0, 2).map((w) => w[0]!.toUpperCase())
  return letters.join('') || first.toUpperCase()
}

function hash(s: string): number {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0
  return Math.abs(h)
}
