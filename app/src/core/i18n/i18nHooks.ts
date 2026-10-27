/**
 * i18n React hooks —— useI18n（独立文件，避免 Fast Refresh 的 only-export-components 限制）。
 */
import { useContext } from 'react'
import { I18nContext, type I18nContextValue } from './i18nContextValue.js'

/** 取 i18n Context；未挂 Provider 时抛错（使用方应保证在 I18nProvider 内） */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    throw new Error('[i18n] useI18n 必须在 I18nProvider 内使用')
  }
  return ctx
}
