import s from './BrandLogo.module.css'

/**
 * Wordmark in the theme's UI font; the "o" of Hot is an on-air dot broadcasting to the right.
 * The glyph is drawn at 1em = 24 units with its bottom edge sitting on the text baseline.
 */
export function BrandLogo() {
  return (
    <span className={s.logo} role="img" aria-label="HotFM">
      <span aria-hidden>H</span>
      <svg className={s.o} viewBox="0 0 20 24" overflow="visible" aria-hidden>
        <circle cx="6.5" cy="17.8" r="5.6" fill="currentColor" />
        <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M13.87 12.64a9 9 0 0 1 0 10.32" />
          <path d="M17.15 10.34a13 13 0 0 1 0 14.92" opacity="0.5" />
        </g>
      </svg>
      <span aria-hidden>tFM</span>
    </span>
  )
}
