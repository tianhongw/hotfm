import { useEffect, useState } from 'react'
import { useUI, type Toast } from '../stores/ui'
import s from './Toaster.module.css'

const PLAIN_MS = 2600
/** Undo needs a moment longer to be reachable. */
const ACTION_MS = 6000

export function Toaster() {
  const toast = useUI((u) => u.toast)
  const [visible, setVisible] = useState<Toast | null>(null)
  useEffect(() => {
    if (!toast) return
    setVisible(toast)
    const id = window.setTimeout(() => setVisible(null), toast.action ? ACTION_MS : PLAIN_MS)
    return () => window.clearTimeout(id)
  }, [toast])
  const run = () => {
    const action = visible?.action
    setVisible(null)
    action?.run()
  }
  return (
    <div className={s.region} role="status" aria-live="polite">
      {visible && (
        <div key={visible.id} className={s.toast}>
          <span className={s.dot} />
          {visible.text}
          {visible.action && (
            <button type="button" className={s.action} onClick={run}>
              {visible.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}