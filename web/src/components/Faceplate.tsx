import { Transport } from './Transport'
import { TunerPanel } from './TunerPanel'
import { VfdDisplay } from './VfdDisplay'
import { VolumeKnob } from './VolumeKnob'
import s from './Faceplate.module.css'

/** The receiver front panel: display window, controls and the (collapsible) tuning dial. */
export function Faceplate() {
  return (
    <section className={s.plate} aria-label="Tuner">
      <div className={s.screws} aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className={s.upper}>
        <VfdDisplay />
        <div className={s.controls}>
          <Transport />
          <div className={s.knobBlock}>
            <VolumeKnob />
            <span className="silk">Volume</span>
          </div>
        </div>
      </div>
      <TunerPanel />
    </section>
  )
}
