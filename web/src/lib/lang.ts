export type Lang = 'zh' | 'en'

export function detectLang(): Lang {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
