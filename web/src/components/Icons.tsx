import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

const base = (size = 18): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
})

export const IconPlay = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />
  </svg>
)
export const IconStop = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" />
  </svg>
)
export const IconSeekPrev = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M11.5 6.5 5 12l6.5 5.5zM19 6.5 12.5 12l6.5 5.5z" fill="currentColor" stroke="none" />
  </svg>
)
export const IconSeekNext = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M12.5 6.5 19 12l-6.5 5.5zM5 6.5 11.5 12 5 17.5z" fill="currentColor" stroke="none" />
  </svg>
)
export const IconHeart = ({ size, filled, ...p }: P & { filled?: boolean }) => (
  <svg {...base(size)} {...p}>
    <path
      d="M12 19.5s-7-4.3-7-9.6A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.3c0 5.3-7 9.6-7 9.6z"
      fill={filled ? 'currentColor' : 'none'}
    />
  </svg>
)
export const IconMoon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" />
  </svg>
)
export const IconWave = ({ size, off, ...p }: P & { off?: boolean }) => (
  <svg {...base(size)} {...p}>
    <path d="M3 12h2l2-5 3 10 3-12 3 10 2-3h3" />
    {off && <path d="M4 20 20 4" />}
  </svg>
)
export const IconDial = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M3 15h18M5 15v-2M8 15v-3M11 15v-2M17 15v-2M20 15v-3" />
    <path d="M14 6v13" strokeWidth="2" />
  </svg>
)
export const IconSearch = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-4.2-4.2" />
  </svg>
)
export const IconMore = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none" />
  </svg>
)
export const IconChevron = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="m7 10 5 5 5-5" />
  </svg>
)
export const IconClose = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)
export const IconSpeaker = ({ size, muted, ...p }: P & { muted?: boolean }) => (
  <svg {...base(size)} {...p}>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none" />
    {muted ? <path d="m16 9.5 5 5m0-5-5 5" /> : <path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />}
  </svg>
)
export const IconKeyboard = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="3" y="6.5" width="18" height="11" rx="2" />
    <path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8" />
  </svg>
)
export const IconExternal = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4" />
  </svg>
)
export const IconLink = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
)
export const IconTrash = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
  </svg>
)

export const IconSun = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="12" r="3.6" />
    <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6" />
  </svg>
)
export const IconPin = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M12 20.5s-6-5.6-6-10.2a6 6 0 0 1 12 0c0 4.6-6 10.2-6 10.2z" />
    <circle cx="12" cy="10.3" r="2.1" />
  </svg>
)
export const IconClock = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="12" r="7.5" />
    <path d="M12 8v4.2l2.8 1.8" />
  </svg>
)
export const IconTag = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M4.5 12.3V5.5a1 1 0 0 1 1-1h6.8l7.2 7.2a1 1 0 0 1 0 1.4l-5.4 5.4a1 1 0 0 1-1.4 0z" />
    <circle cx="8.6" cy="8.6" r="1.2" fill="currentColor" stroke="none" />
  </svg>
)
export const IconCaptions = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
    <path d="M10.6 10.2a2.2 2.2 0 1 0 0 3.6M17 10.2a2.2 2.2 0 1 0 0 3.6" />
  </svg>
)
export const IconRecord = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none" />
  </svg>
)
export const IconDownload = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M12 4.5v10.5M7.5 10.8 12 15.3l4.5-4.5M5 19.5h14" />
  </svg>
)
