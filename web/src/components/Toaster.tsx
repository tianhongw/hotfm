import { useEffect, useState } from 'react'
import { useUI } from '../stores/ui'
import s from './Toaster.module.css'

export function Toaster() {
  const toast = useUI((u) => u.toast)
  const [visible, setVisible] = useState<typeof toast>(null)
  useEffect(() => {
    if (!toast) return
    setVisible(toast)
    const id = window.setTimeout(() => setVisible(null), 2600)
    return () => window.clearTimeout(id)
  }, [toast])
  return (
    <div className={s.region} role="status" aria-live="polite">
      {visible && (
        <div key={visible.id} className={s.toast}>
          <span className={s.dot} />
          {visible.text}
        </div>
      )}
    </div>
  )
}
