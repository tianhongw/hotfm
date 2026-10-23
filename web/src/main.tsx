import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/600.css'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/global.css'

import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initCapture } from './capture/session'
import { initPlayer, queryClient } from './player/controller'
import { initMediaSession } from './player/mediaSession'
import { initTuning } from './player/tuning'
import { useLibrary } from './stores/library'
import { resolvedTheme } from './lib/appearance'

initPlayer()
initTuning()
initMediaSession()
initCapture()

const syncLang = () => (document.documentElement.lang = useLibrary.getState().lang === 'zh' ? 'zh-CN' : 'en')
syncLang()
useLibrary.subscribe(syncLang)

const THEME_COLOR = { apple: '#f5f5f7', 'apple-dark': '#161618', hifi: '#0d0c0a' }
const systemAppearance = window.matchMedia('(prefers-color-scheme: dark)')
const syncTheme = () => {
  const { theme: selectedTheme, colorMode } = useLibrary.getState()
  const theme = resolvedTheme(selectedTheme, colorMode, systemAppearance.matches)
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme])
}
syncTheme()
useLibrary.subscribe(syncTheme)
systemAppearance.addEventListener('change', syncTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
