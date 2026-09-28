/**
 * CC Deck — tiny i18n runtime. FROZEN.
 *
 * No external dependency: a plain dictionary lookup with `{var}` interpolation,
 * driven by `AppSettings.language`. Components call `useT()` to get a bound
 * `t()` function; the whole UI re-renders when the language changes because the
 * language lives in the zustand settings store.
 *
 * Usage:
 *   const t = useT()
 *   t('workspaces.launch.launch')                       // -> "Launch" | "启动"
 *   t('workspaces.launch.verified', { exe, version, path })
 */
import { useCallback } from 'react'
import type { Language } from '@shared/types'
import { useSettingsStore } from '@/store/settings'
import { en } from './en'
import { zh } from './zh'

export type TranslationKey = keyof typeof en
export type TVars = Record<string, string | number>
export type TFunction = (key: TranslationKey, vars?: TVars) => string

const DICTS: Record<Language, Record<string, string>> = {
  en: en as unknown as Record<string, string>,
  zh: zh as unknown as Record<string, string>
}

export const LANGUAGES: Language[] = ['en', 'zh']
export const DEFAULT_LANGUAGE: Language = 'en'

/** Interpolate `{name}` placeholders in `template`. */
function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template
  let out = template
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(String(v))
  }
  return out
}

/** Translate `key` for `lang`, falling back to English then the key itself. */
export function translate(lang: Language, key: TranslationKey, vars?: TVars): string {
  const dict = DICTS[lang] ?? DICTS[DEFAULT_LANGUAGE]
  const template = dict[key] ?? DICTS[DEFAULT_LANGUAGE][key] ?? String(key)
  return interpolate(template, vars)
}

/** Current UI language from settings (defaults to English). */
export function useLanguage(): Language {
  return useSettingsStore((s) => s.settings?.language ?? DEFAULT_LANGUAGE)
}

/** A `t()` function bound to the current language. */
export function useT(): TFunction {
  const lang = useLanguage()
  return useCallback<TFunction>((key, vars) => translate(lang, key, vars), [lang])
}

/** Set the UI language (persists via settings). */
export function useSetLanguage(): (lang: Language) => void {
  const update = useSettingsStore((s) => s.update)
  return useCallback((lang: Language) => void update({ language: lang }), [update])
}
