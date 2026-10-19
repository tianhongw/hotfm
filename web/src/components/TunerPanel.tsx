import { useT } from '../i18n'
import { useLibrary } from '../stores/library'
import { useUI } from '../stores/ui'
import { IconWave } from './Icons'
import { SignalMeter } from './SignalMeter'
import { TuningDial } from './TuningDial'
import s from './TunerPanel.module.css'

/** Signal meter, tuning-static switch and the dial; only mounted while the dial is shown. */
export function TunerPanel({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const open = useUI((u) => u.dialOpen)
  const noise = useLibrary((l) => l.noise)
  const setNoise = useLibrary((l) => l.setNoise)
  if (!open) return null
  return (
    <div className={s.panel} data-compact={compact || undefined}>
      <div className={s.head}>
        {!compact && <span className="silk">Tuning</span>}
        <div className={s.meter}>
          <SignalMeter />
        </div>
        <button
          className={s.noise}
          data-on={noise || undefined}
          onClick={() => setNoise(!noise)}
          aria-pressed={noise}
          aria-label={t('transport.noise')}
          title={t('transport.noise')}
        >
          <IconWave size={16} off={!noise} />
        </button>
      </div>
      <TuningDial compact={compact} />
    </div>
  )
}
