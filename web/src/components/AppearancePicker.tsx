import { useCallback } from 'react'
import { useT } from '../i18n'
import { useLibrary, THEMES, type ColorMode } from '../stores/library'
import { useUI } from '../stores/ui'
import { Dialog } from './Dialog'
import { IconClose, IconSun } from './Icons'
import s from './Header.module.css'

export function AppearancePicker() {
  const t = useT()
  const { theme, colorMode, setTheme, setColorMode } = useLibrary()
  const open = useUI((u) => u.appearanceOpen)
  const setOpen = useUI((u) => u.setAppearanceOpen)
  const close = useCallback(() => setOpen(false), [setOpen])
  return (
    <>
      <button className={s.tool} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        <IconSun size={17} />
        <span>{t('theme.switch')}</span>
      </button>
      <Dialog open={open} onClose={close} label={t('theme.switch')}>
        <div className={s.appearance}>
          <div className={s.dialogTitle}>
            <h2>{t('theme.switch')}</h2>
            <button onClick={close} aria-label={t('location.close')}>
              <IconClose />
            </button>
          </div>
          <div className={s.themeOptions} role="group" aria-label={t('theme.switch')}>
            {THEMES.map((item) => (
              <button key={item} className={s.themeOption} aria-pressed={theme === item} onClick={() => setTheme(item)}>
                <span className={s.themePreview} data-preview={item}>
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  {t(`theme.${item}`)}
                  <span aria-hidden>{theme === item ? ' ✓' : ''}</span>
                </span>
              </button>
            ))}
          </div>
          {theme === 'apple' && (
            <fieldset className={s.modes}>
              <legend>{t('theme.mode')}</legend>
              {(['light', 'dark', 'system'] as ColorMode[]).map((mode) => (
                <label key={mode}>
                  <input type="radio" name="color-mode" checked={colorMode === mode} onChange={() => setColorMode(mode)} />
                  {t(`theme.${mode}`)}
                </label>
              ))}
            </fieldset>
          )}
        </div>
      </Dialog>
    </>
  )
}
