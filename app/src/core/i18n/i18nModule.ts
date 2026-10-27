/**
 * i18n 模块 —— 注册框架级 UI 文案（menu 命名空间），并暴露语言切换命令。
 *
 * 架构约定：模块 init 时向 i18n 注册器注册自己的翻译资源。
 * 这里注册顶部菜单栏文案；其它模块（设置、资源管理器…）各自 init 时注册自己的命名空间。
 */
import type { Module, ModuleContext } from '../module.js'

/** i18n 模块实例类型（保留扩展：可挂公开 API） */
export interface I18nModule extends Module {}

export function createI18nModule(): I18nModule {
  const module: I18nModule = {
    id: 'i18n',

    async init(ctx: ModuleContext): Promise<void> {
      // 系统级文案（app/language/common/menu/settings）统一在 system 命名空间，
      // 由 createI18nRegistry 预置，此处无需 register。

      // 命令：切换语言（settings 语言字段联动 / 手动切换统一入口）
      ctx.events.define({
        name: 'command:system.i18n:setLocale',
        description: '切换界面语言，载荷 { locale: string }',
      })
      ctx.commands.onCommand('system.i18n:setLocale', (args) => {
        const { locale } = (args ?? {}) as { locale?: string }
        if (!locale) {
          console.warn('[i18n] system.i18n:setLocale 缺少 locale')
          return
        }
        ctx.i18n.setLocale(locale)
      })
    },
  }

  return module
}
