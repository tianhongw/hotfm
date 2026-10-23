import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clock, elapsed } from '../capture/export'
import {
  canCapture,
  canRecord,
  discardRecording,
  downloadRecording,
  downloadTranscript,
  isEnglish,
  retryCaptions,
  stopRecording,
} from '../capture/session'
import { useNow } from '../hooks/useNow'
import { useT } from '../i18n'
import { useCapture } from '../stores/capture'
import { usePlayer } from '../stores/player'
import { useUI } from '../stores/ui'
import { beginRecording } from './CaptureButtons'
import { IconChevron, IconClose, IconDownload, IconRecord, IconTrash } from './Icons'
import { Logo } from './Logo'
import s from './TranscriptPanel.module.css'

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`

/** Non-modal side panel: live captions, transcript download and recording. */
export function TranscriptPanel({ docked }: { docked: boolean }) {
  const t = useT()
  const open = useUI((u) => u.transcriptOpen)
  const setOpen = useUI((u) => u.setTranscriptOpen)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // Leave Escape to a modal dialog when one is open (it makes the app inert).
      if (e.key === 'Escape' && !e.defaultPrevented && !document.getElementById('root')?.inert) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null
  return (
    <aside className={s.panel} data-docked={docked || undefined} aria-label={t('capture.panel')}>
      <Header onClose={() => setOpen(false)} />
      <Log />
      <Footer />
    </aside>
  )
}

function Header({ onClose }: { onClose: () => void }) {
  const t = useT()
  const station = usePlayer((p) => p.station)
  const title = usePlayer((p) => p.title)
  const status = usePlayer((p) => p.status)
  const { captionsOn, asr, progress, busy, setCaptions, rec } = useCapture()
  const english = isEnglish(station)
  const playing = status === 'playing' || status === 'buffering'
  const recCaptions = rec.state === 'recording' && rec.withCaptions

  let chip: { tone: 'idle' | 'live' | 'busy' | 'warn'; text: string }
  if (!captionsOn && recCaptions) {
    chip = asr === 'ready' ? { tone: 'live', text: t('capture.recAuto') } : { tone: 'busy', text: t('capture.loading', { n: progress }) }
  } else if (!captionsOn) chip = { tone: 'idle', text: t('capture.off') }
  else if (station && !english) chip = { tone: 'warn', text: t('capture.englishOnly') }
  else if (asr === 'error') chip = { tone: 'warn', text: t('capture.error') }
  else if (!canCapture(station)) chip = { tone: 'idle', text: t('capture.needPlay') }
  else if (asr !== 'ready') chip = { tone: 'busy', text: t('capture.loading', { n: progress }) }
  else if (!playing) chip = { tone: 'idle', text: t('capture.paused') }
  else chip = busy ? { tone: 'busy', text: t('capture.transcribing') } : { tone: 'live', text: t('capture.listening') }

  return (
    <header className={s.head}>
      <div className={s.titleRow}>
        <h2>{t('capture.panel')}</h2>
        <button className={s.iconBtn} onClick={onClose} aria-label={t('capture.close')} title={t('capture.close')}>
          <IconClose size={17} />
        </button>
      </div>
      {station && (
        <div className={s.station}>
          <Logo src={station.logo} name={station.name} size={36} />
          <span>
            <strong>{station.name}</strong>
            <small>{title || (playing ? t('player.live') : status === 'idle' ? t('player.paused') : t(`player.${status}`))}</small>
          </span>
        </div>
      )}
      <div className={s.controlRow}>
        <span className={s.chip} data-tone={chip.tone}>
          <i />
          {chip.text}
        </span>
        {asr === 'error' && captionsOn ? (
          <button className={s.link} onClick={retryCaptions}>
            {t('capture.retry')}
          </button>
        ) : (
          <label className={s.switch}>
            <span>{t('capture.cc')}</span>
            <input type="checkbox" role="switch" checked={captionsOn} onChange={(e) => setCaptions(e.target.checked)} />
          </label>
        )}
      </div>
      {(captionsOn || recCaptions) && english && asr === 'loading' && canCapture(station) && (
        <div className={s.loading}>
          <div className={s.bar} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <small>{t('capture.loadingHint')}</small>
        </div>
      )}
    </header>
  )
}

function Log() {
  const t = useT()
  const segments = useCapture((c) => c.segments)
  const busy = useCapture((c) => c.busy)
  const interim = useCapture((c) => c.interim)
  const captionsOn = useCapture((c) => c.captionsOn)
  const station = usePlayer((p) => p.station)
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  useLayoutEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [segments, busy, interim])

  const onScroll = () => {
    const el = box.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    setAtBottom(stick.current)
  }
  const jump = () => {
    const el = box.current
    if (!el) return
    stick.current = true
    setAtBottom(true)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  let latest = -1
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]!.kind === 'text') {
      latest = segments[i]!.id
      break
    }
  }

  return (
    <div className={s.logWrap}>
      <div className={s.log} ref={box} onScroll={onScroll} role="log" aria-live="polite" tabIndex={0}>
        {segments.length === 0 && !interim && <p className={s.empty}>{!captionsOn ? t('capture.emptyOff') : station && !isEnglish(station) ? t('capture.englishOnly') : t('capture.empty')}</p>}
        {segments.map((seg) =>
          seg.kind === 'text' ? (
            <p key={seg.id} className={s.line} data-latest={seg.id === latest || undefined}>
              <time>{clock(seg.at)}</time>
              <span>{seg.text}</span>
            </p>
          ) : (
            <p key={seg.id} className={s.divider}>
              <span>{t('capture.switched', { name: seg.name })}</span>
            </p>
          ),
        )}
        {interim && (
          <p className={s.line} data-interim>
            <time>{clock(interim.at)}</time>
            <span>{interim.text}</span>
          </p>
        )}
        {busy && !interim && segments.length > 0 && (
          <p className={s.pending} aria-hidden>
            <i />
            <i />
            <i />
          </p>
        )}
      </div>
      {!atBottom && (
        <button className={s.jump} onClick={jump}>
          <IconChevron size={14} />
          {t('capture.jump')}
        </button>
      )}
    </div>
  )
}

function Footer() {
  const t = useT()
  const rec = useCapture((c) => c.rec)
  const segments = useCapture((c) => c.segments)
  const clear = useCapture((c) => c.clear)
  const asr = useCapture((c) => c.asr)
  const progress = useCapture((c) => c.progress)
  const station = usePlayer((p) => p.station)
  const status = usePlayer((p) => p.status)
  const now = useNow(rec.state === 'recording')
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      await downloadRecording()
    } finally {
      setSaving(false)
    }
  }
  const active = status === 'playing' || status === 'buffering' || status === 'connecting'
  const hasText = segments.some((x) => x.kind === 'text')
  const recordable = canRecord() && !!station && active

  return (
    <footer className={s.foot}>
      {rec.state === 'recording' && (
        <div className={s.recStrip}>
          <i />
          <span className={s.recLabel}>{t('capture.recording')}</span>
          <span className={s.recMeta}>
            {elapsed(now - rec.startedAt)} · {mb(rec.bytes)}
          </span>
          <button onClick={stopRecording}>{t('capture.recStop')}</button>
        </div>
      )}
      {rec.state === 'done' && (
        <div className={s.recCard}>
          <div className={s.recCardHead}>
            <span>
              <strong>{t('capture.recDone', { d: elapsed(rec.endedAt - rec.startedAt), size: mb(rec.bytes) })}</strong>
              <small>
                {rec.stationName} · {clock(rec.startedAt)}
                {rec.saved ? ` · ${t('capture.recSaved')}` : ''}
              </small>
            </span>
            <button className={s.iconBtn} onClick={discardRecording} aria-label={t('capture.recDiscard')} title={t('capture.recDiscard')}>
              <IconTrash size={16} />
            </button>
          </div>
          <button className={s.primary} onClick={() => void save()} disabled={saving} aria-busy={saving}>
            <IconDownload size={17} />
            {saving && rec.withCaptions
              ? asr === 'loading'
                ? t('capture.loading', { n: progress })
                : t('capture.recPreparing')
              : rec.withCaptions
                ? t('capture.recSaveZip')
                : t('capture.recSaveAudio')}
          </button>
        </div>
      )}
      <div className={s.actions}>
        {rec.state !== 'recording' && (
          <button className={s.record} disabled={!recordable} onClick={() => beginRecording(t)} title={t('capture.recHint')}>
            <IconRecord size={16} />
            {t('capture.rec')}
          </button>
        )}
        <span className={s.spacer} />
        <button className={s.ghost} disabled={!hasText} onClick={downloadTranscript}>
          <IconDownload size={15} />
          {t('capture.saveTxt')}
        </button>
        <button className={s.ghost} disabled={segments.length === 0} onClick={clear}>
          {t('capture.clear')}
        </button>
      </div>
    </footer>
  )
}
