import { Faceplate } from './components/Faceplate'
import { Header } from './components/Header'
import { MiniPlayer, PlayerSheet } from './components/MobilePlayer'
import { ApplePlayer } from './components/ApplePlayer'
import { useLibrary } from './stores/library'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { StationBrowser } from './components/StationBrowser'
import { Toaster } from './components/Toaster'
import { CaptionStage, TranscriptPanel } from './components/TranscriptPanel'
import { useUI } from './stores/ui'
import { useBootstrap } from './hooks/useBootstrap'
import { useKeyboard } from './hooks/useKeyboard'
import { useIsMobile } from './hooks/useMediaQuery'
import s from './App.module.css'

export function App() {
  useBootstrap()
  useKeyboard()
  const mobile = useIsMobile()
  const apple = useLibrary((l) => l.theme === 'apple')
  const transcript = useUI((u) => u.transcriptOpen) && !mobile
  return (
    <div className={s.app} data-mobile={mobile || undefined} data-apple={apple || undefined} data-transcript={transcript || undefined}>
      <div className={s.inner}>
        <Header />
        <main className={s.main}>
          {!mobile && !apple && (
            <div className={s.tuner}>
              <Faceplate />
            </div>
          )}
          <StationBrowser />
        </main>
        <footer className={s.footer}>
          <span className="silk">HotFM</span>
          <span>
            Station data ©{' '}
            <a href="https://www.radio-browser.info" target="_blank" rel="noreferrer">
              Radio Browser
            </a>{' '}
            community
          </span>
        </footer>
      </div>
      {!apple && mobile && <MiniPlayer />}
      {!apple && mobile && <PlayerSheet />}
      {apple && <ApplePlayer />}
      {!mobile && <TranscriptPanel docked={apple} />}
      {!mobile && <CaptionStage />}
      <ShortcutsDialog />
      <Toaster />
    </div>
  )
}
