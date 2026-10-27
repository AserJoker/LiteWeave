/**
 * React i18n 集成 —— 全局通过 Context 传递当前语言与取字符串能力。
 *
 * 本文件只含 I18nProvider（Context 定义见 i18nContextValue.ts，消费侧 useI18n / I18n 见 i18nHooks.ts / i18n.tsx，
 * 分离以保 Fast Refresh 只导出组件）。
 *
 * - I18nProvider：读 core.i18n，把 { t, setLocale, locale } 注入 Context；
 *   订阅语言切换事件驱动全局重渲染（语言切换后所有 I18n 组件实时更新）。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { I18nRegistry } from './i18nRegistry.js'
import { I18nContext, type I18nContextValue } from './i18nContextValue.js'

/* ---------------- Provider ---------------- */

interface I18nProviderProps {
  /** core.i18n 注册器 */
  i18n: I18nRegistry
  children: ReactNode
}

/**
 * 全局 i18n Provider：注入 t/locale/setLocale。
 * 订阅语言切换事件，locale 变化时重渲染，让所有 I18n 组件实时更新。
 */
export function I18nProvider({ i18n, children }: I18nProviderProps) {
  // 当前语言：本地镜像，切换时更新驱动重渲染
  const [locale, setLocaleState] = useState<string>(i18n.getLocale())

  // 订阅语言切换：core 侧 setLocale → 广播 → 本 Provider 更新 locale → 重渲染
  useEffect(() => {
    return i18n.onLocaleChanged(({ locale: next }) => {
      setLocaleState(next)
    })
  }, [i18n])

  const value = useMemo<I18nContextValue>(
    () => ({
      t: (key: string) => i18n.t(key),
      locale,
      setLocale: (localeId: string) => i18n.setLocale(localeId),
    }),
    [i18n, locale],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
