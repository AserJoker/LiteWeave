/**
 * I18n 组件 —— props 是 key，渲染成结果字符串（纯组件文件，Fast Refresh 安全）。
 *
 * 用法：<I18n i18nKey="system.app.name" /> → LiteWeave
 * 未命中时回退 key 本身（便于开发期发现缺失）。
 */
import { useI18n } from './i18nHooks.js'

export function I18n({ i18nKey }: { i18nKey: string }) {
  const { t } = useI18n()
  // 直接渲染字符串（不包 span，保持纯文本语义）
  return <>{t(i18nKey)}</>
}
