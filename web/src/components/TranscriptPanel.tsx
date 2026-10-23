import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Station } from '../api/types'
import { clock, elapsed, type Segment } from '../capture/export'
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
import { READER_SIZE, useUI } from '../stores/ui'
import { beginRecording } from './CaptureButtons'
import { IconChevron, IconClose, IconDownload, IconExpand, IconRecord, IconShrink, IconTrash } from './Icons'
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
      if (e.key !== 'Escape' || e.defaultPrevented || document.getElementById('root')?.inert) return
      // Full-screen captions step back to the panel first.
      const ui = useUI.getState()
      if (ui.captionsFull) ui.setCaptionsFull(false)
      else setOpen(false)
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

type Chip = { tone: 'idle' | 'live' | 'busy' | 'warn'; text: string }

/** What the captioner is doing right now, as a status chip; shared by the panel and the full-screen view. */
function useCaptionStatus() {
  const t = useT()
  const station = usePlayer((p) => p.station)
  const title = usePlayer((p) => p.title)
  const status = usePlayer((p) => p.status)
  const { captionsOn, asr, progress, busy, rec } = useCapture()
  const english = isEnglish(station)
  const playing = status === 'playing' || status === 'buffering'
  const recCaptions = rec.state === 'recording' && rec.withCaptions
  const subtitle = title || (playing ? t('player.live') : status === 'idle' ? t('player.paused') : t(`player.${status}`))

  let chip: Chip
  if (!captionsOn && recCaptions) {
    chip = asr === 'ready' ? { tone: 'live', text: t('capture.recAuto') } : { tone: 'busy', text: t('capture.loading', { n: progress }) }
  } else if (!captionsOn) chip = { tone: 'idle', text: t('capture.off') }
  else if (station && !english) chip = { tone: 'warn', text: t('capture.englishOnly') }
  else if (asr === 'error') chip = { tone: 'warn', text: t('capture.error') }
  else if (!canCapture(station)) chip = { tone: 'idle', text: t('capture.needPlay') }
  else if (asr !== 'ready') chip = { tone: 'busy', text: t('capture.loading', { n: progress }) }
  else if (!playing) chip = { tone: 'idle', text: t('capture.paused') }
  else chip = busy ? { tone: 'busy', text: t('capture.transcribing') } : { tone: 'live', text: t('capture.listening') }

  return { chip, station, subtitle, english, recCaptions, captionsOn, asr, progress }
}

/** The CC switch, or a retry link when the speech model failed to load. */
function CaptionSwitch() {
  const t = useT()
  const captionsOn = useCapture((c) => c.captionsOn)
  const asr = useCapture((c) => c.asr)
  const setCaptions = useCapture((c) => c.setCaptions)
  return asr === 'error' && captionsOn ? (
    <button className={s.link} onClick={retryCaptions}>
      {t('capture.retry')}
    </button>
  ) : (
    <label className={s.switch}>
      <span>{t('capture.cc')}</span>
      <input type="checkbox" role="switch" checked={captionsOn} onChange={(e) => setCaptions(e.target.checked)} />
    </label>
  )
}

function StatusChip({ chip }: { chip: Chip }) {
  return (
    <span className={s.chip} data-tone={chip.tone}>
      <i />
      {chip.text}
    </span>
  )
}

function Header({ onClose }: { onClose: () => void }) {
  const t = useT()
  const setFull = useUI((u) => u.setCaptionsFull)
  const { chip, station, subtitle, english, recCaptions, captionsOn, asr, progress } = useCaptionStatus()

  return (
    <header className={s.head}>
      <div className={s.titleRow}>
        <h2>{t('capture.panel')}</h2>
        <span className={s.titleBtns}>
          <button className={s.iconBtn} onClick={() => setFull(true)} aria-label={t('capture.fullscreen')} title={t('capture.fullscreen')}>
            <IconExpand size={16} />
          </button>
          <button className={s.iconBtn} onClick={onClose} aria-label={t('capture.close')} title={t('capture.close')}>
            <IconClose size={17} />
          </button>
        </span>
      </div>
      {station && (
        <div className={s.station}>
          <Logo src={station.logo} name={station.name} size={36} />
          <span>
            <strong>{station.name}</strong>
            <small>{subtitle}</small>
          </span>
        </div>
      )}
      <div className={s.controlRow}>
        <StatusChip chip={chip} />
        <CaptionSwitch />
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

const emptyKey = (captionsOn: boolean, station: Station | null) =>
  !captionsOn ? 'capture.emptyOff' : station && !isEnglish(station) ? 'capture.englishOnly' : 'capture.empty'

/** Keeps a scroller pinned to its end while the reader is there; scrolling up to reread unpins it. */
function useStickToBottom(deps: unknown[], smooth = false) {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  useLayoutEffect(() => {
    const el = box.current
    if (!el || !stick.current) return
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }, deps)

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
  return { box, atBottom, onScroll, jump }
}

function Log() {
  const t = useT()
  const segments = useCapture((c) => c.segments)
  const busy = useCapture((c) => c.busy)
  const interim = useCapture((c) => c.interim)
  const captionsOn = useCapture((c) => c.captionsOn)
  const station = usePlayer((p) => p.station)
  const { box, atBottom, onScroll, jump } = useStickToBottom([segments, busy, interim])

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
        {segments.length === 0 && !interim && <p className={s.empty}>{t(emptyKey(captionsOn, station))}</p>}
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

type TextSegment = Extract<Segment, { kind: 'text' }>

/** Full-window captions: the last few lines, newest biggest. The panel stays mounted underneath. */
export function CaptionStage() {
  const t = useT()
  const open = useUI((u) => u.transcriptOpen && u.captionsFull)
  const setFull = useUI((u) => u.setCaptionsFull)
  if (!open) return null
  return (
    <section className={s.stage} aria-label={t('capture.fullscreen')}>
      <StageBar onExit={() => setFull(false)} />
      <StageReader />
    </section>
  )
}

function StageBar({ onExit }: { onExit: () => void }) {
  const t = useT()
  const { chip, station, subtitle } = useCaptionStatus()
  const rec = useCapture((c) => c.rec)
  const now = useNow(rec.state === 'recording')
  return (
    <header className={s.stageBar}>
      {station && (
        <div className={s.station}>
          <Logo src={station.logo} name={station.name} size={40} />
          <span>
            <strong>{station.name}</strong>
            <small>{subtitle}</small>
          </span>
        </div>
      )}
      <span className={s.spacer} />
      {rec.state === 'recording' && (
        <span className={s.stageRec}>
          <i />
          {t('capture.recording')} {elapsed(now - rec.startedAt)}
        </span>
      )}
      <StatusChip chip={chip} />
      <CaptionSwitch />
      <FontSize />
      <button className={s.iconBtn} onClick={onExit} aria-label={t('capture.exitFullscreen')} title={t('capture.exitFullscreen')}>
        <IconShrink size={18} />
      </button>
    </header>
  )
}

function FontSize() {
  const t = useT()
  const size = useUI((u) => u.readerSize)
  const setSize = useUI((u) => u.setReaderSize)
  return (
    <span className={s.fontSize} role="group" aria-label={t('capture.fontSize')}>
      <button
        onClick={() => setSize(size - READER_SIZE.step)}
        disabled={size <= READER_SIZE.min}
        aria-label={t('capture.fontSmaller')}
        title={t('capture.fontSmaller')}
      >
        A
      </button>
      <output aria-live="polite">{size}</output>
      <button
        onClick={() => setSize(size + READER_SIZE.step)}
        disabled={size >= READER_SIZE.max}
        aria-label={t('capture.fontLarger')}
        title={t('capture.fontLarger')}
      >
        A
      </button>
    </span>
  )
}

type Block = { kind: 'para'; id: number; segs: TextSegment[] } | { kind: 'station'; id: number; name: string }

/** A pause this long between sentences starts a new paragraph. */
const PARA_GAP_MS = 2500
const PARA_MAX = 6

/** Groups sentences into paragraphs, the way a page reads, with station switches as section breaks. */
function toBlocks(segments: Segment[]): Block[] {
  const blocks: Block[] = []
  let para: Extract<Block, { kind: 'para' }> | null = null
  for (const seg of segments) {
    if (seg.kind !== 'text') {
      para = null
      blocks.push({ kind: 'station', id: seg.id, name: seg.name })
      continue
    }
    const last = para?.segs[para.segs.length - 1]
    if (!para || !last || seg.at - (last.at + last.dur) > PARA_GAP_MS || para.segs.length >= PARA_MAX) {
      para = { kind: 'para', id: seg.id, segs: [] }
      blocks.push(para)
    }
    para.segs.push(seg)
  }
  return blocks
}

function StageReader() {
  const t = useT()
  const segments = useCapture((c) => c.segments)
  const interim = useCapture((c) => c.interim)
  const captionsOn = useCapture((c) => c.captionsOn)
  const station = usePlayer((p) => p.station)
  const size = useUI((u) => u.readerSize)
  // Follow committed sentences only, so the page doesn't nudge on every interim update.
  const { box, atBottom, onScroll, jump } = useStickToBottom([segments, !!interim], true)
  const blocks = toBlocks(segments)
  const last = blocks[blocks.length - 1]

  return (
    <div className={s.logWrap}>
      <div className={s.reader} ref={box} onScroll={onScroll} role="log" aria-live="polite" tabIndex={0}>
        <article className={s.page} style={{ fontSize: size }}>
          {blocks.length === 0 && !interim && <p className={s.readerEmpty}>{t(emptyKey(captionsOn, station))}</p>}
          {blocks.map((b) =>
            b.kind === 'station' ? (
              <p key={b.id} className={s.readerBreak}>
                {t('capture.switched', { name: b.name })}
              </p>
            ) : (
              <p key={b.id}>
                {b.segs.map((seg) => seg.text).join(' ')}
                {b === last && interim && <span className={s.readerInterim}> {interim.text}</span>}
              </p>
            ),
          )}
          {interim && last?.kind !== 'para' && (
            <p>
              <span className={s.readerInterim}>{interim.text}</span>
            </p>
          )}
        </article>
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
