import { useLang, useT } from '../i18n'
import { useLibrary } from '../stores/library'
import { useUI } from '../stores/ui'
import { AppearancePicker } from './AppearancePicker'
import { BrandLogo } from './BrandLogo'
import { IconKeyboard } from './Icons'
import s from './Header.module.css'

export function Header() {
  const t = useT()
  const lang = useLang()
  const setLang = useLibrary((l) => l.setLang)
  const openShortcuts = useUI((u) => u.setShortcutsOpen)
  return (
    <header className={s.header}>
      <div className={s.top}>
        <BrandLogo />
        <div className={s.tools}>
          <AppearancePicker />
          <button className={`${s.tool} ${s.language}`} onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} aria-label="Language">
            {t('lang.switch')}
          </button>
          <button
            className={`${s.tool} ${s.hideMobile}`}
            onClick={() => openShortcuts(true)}
            aria-label={t('shortcuts.title')}
            title={t('shortcuts.title')}
          >
            <IconKeyboard size={18} />
          </button>
        </div>
      </div>
    </header>
  )
}
