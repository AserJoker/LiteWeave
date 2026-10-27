/**
 * i18n Context 值类型与 Context 对象（独立文件，供 Provider / hook / 组件共享）。
 * 与组件文件分离，避免 Fast Refresh 的 only-export-components 限制。
 */
import { createContext } from 'react'

/** i18n Context 值：t 取字符串 + 当前语言 + 语言切换 */
export interface I18nContextValue {
  /** 取当前语言的字符串：t('namespace.a.b.c') */
  t: (key: string) => string
  /** 当前语言 id（如 "zh-CN"） */
  locale: string
  /** 切换语言 */
  setLocale: (localeId: string) => void
}

export const I18nContext = createContext<I18nContextValue | null>(null)
