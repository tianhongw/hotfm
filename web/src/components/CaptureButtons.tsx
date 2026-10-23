import { elapsed } from '../capture/export'
import { isEnglish, startRecording, stopRecording } from '../capture/session'
import { useNow } from '../hooks/useNow'
import { useT } from '../i18n'
import { meterCapable } from '../player/audio'
import { useCapture } from '../stores/capture'
import { usePlayer } from '../stores/player'
import { useUI } from '../stores/ui'
import { IconCaptions, IconRecord } from './Icons'
import s from './CaptureButtons.module.css'

/** Starts a recording, confirming first if it would replace one not yet downloaded. */
export function beginRecording(t: ReturnType<typeof useT>) {
  const { rec } = useCapture.getState()
  if (rec.state === 'done' && !rec.saved && !window.confirm(t('capture.recReplace'))) return
  if (!startRecording()) useUI.getState().showToast(t('capture.recFail'))
}

/** CC + Record, for the player bar and the classic transport. Desktop only: both need Web Audio. */
export function CaptureButtons({ className }: { className?: string }) {
  const t = useT()
  const station = usePlayer((p) => p.station)
  const status = usePlayer((p) => p.status)
  const captionsOn = useCapture((c) => c.captionsOn)
  const rec = useCapture((c) => c.rec)
  const open = useUI((u) => u.transcriptOpen)
  const setOpen = useUI((u) => u.setTranscriptOpen)
  const recording = rec.state === 'recording'
  const now = useNow(recording)
  if (!meterCapable) return null

  const english = isEnglish(station)
  const active = status === 'playing' || status === 'buffering' || status === 'connecting'
  const ccLabel = english || !station ? t('capture.open') : t('capture.englishOnly')

  const onCaptions = () => {
    if (open) return setOpen(false)
    setOpen(true)
    if (english && !captionsOn) useCapture.getState().setCaptions(true)
  }
  const onRecord = () => {
    if (recording) {
      stopRecording()
      setOpen(true)
    } else {
      beginRecording(t)
    }
  }

  return (
    <>
      <button
        className={`${className ?? ''} ${s.cc}`}
        data-on={(captionsOn && english) || undefined}
        aria-expanded={open}
        aria-label={ccLabel}
        title={ccLabel}
        onClick={onCaptions}
      >
        <IconCaptions size={20} />
      </button>
      {recording ? (
        <button className={s.recPill} onClick={onRecord} aria-label={t('capture.recStop')} title={t('capture.recStop')}>
          <i />
          <span>{elapsed(now - rec.startedAt)}</span>
        </button>
      ) : (
        <button
          className={`${className ?? ''} ${s.rec}`}
          disabled={!station || !active}
          onClick={onRecord}
          aria-label={t('capture.rec')}
          title={`${t('capture.rec')} — ${t('capture.recHint')}`}
        >
          <IconRecord size={19} />
        </button>
      )}
    </>
  )
}
