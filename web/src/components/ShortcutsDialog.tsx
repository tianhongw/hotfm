import { useT, type TKey } from '../i18n'
import { useUI } from '../stores/ui'
import { Dialog } from './Dialog'
import s from './ShortcutsDialog.module.css'

const ROWS: [string[], TKey][] = [
  [['Space'], 'shortcuts.play'],
  [['←', '→'], 'shortcuts.tune'],
  [['Shift', '←/→'], 'shortcuts.seek'],
  [['T'], 'shortcuts.dial'],
  [['F'], 'shortcuts.fav'],
  [['/'], 'shortcuts.search'],
  [['L'], 'shortcuts.location'],
  [['↑', '↓'], 'shortcuts.volume'],
  [['M'], 'shortcuts.mute'],
  [['?'], 'shortcuts.help'],
]

export function ShortcutsDialog() {
  const t = useT()
  const open = useUI((u) => u.shortcutsOpen)
  const setOpen = useUI((u) => u.setShortcutsOpen)
  return (
    <Dialog open={open} onClose={() => setOpen(false)} label={t('shortcuts.title')}>
      <div className={s.body}>
        <div className={`silk ${s.title}`}>{t('shortcuts.title')}</div>
        <dl className={s.list}>
          {ROWS.map(([keys, label]) => (
            <div key={label} className={s.row}>
              <dt>
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </dt>
              <dd>{t(label)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Dialog>
  )
}
