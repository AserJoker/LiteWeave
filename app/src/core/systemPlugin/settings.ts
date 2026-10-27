/**
 * settings 业务域 —— 设置 / 布局 / i18n 命令与设置语言联动。
 *
 * 内容：
 * - MCP 命令：system.settings:set / system.layout:set / system.i18n:setLocale
 * - 命令占位：打开设置对话框 / 打开组件演示对话框（MenuBar 订阅打开弹窗，这里仅 define 事件契约 + 占位 handler）
 * - 订阅：settings 首次加载 / 变更时同步 i18n 语言（settings 字段 ↔ i18n）
 */
import type { PluginContext } from '../module.js'
import { SETTINGS_CHANGED, SETTINGS_LOADED } from '../store/storeModule.js'
import { OPEN_SETTINGS_COMMAND } from '../../components/shell/MenuBar.js'

/** init：注册 settings/layout/i18n MCP 命令 + 命令占位 + 设置语言联动订阅 */
export function registerSettings(ctx: PluginContext): void {
  /* ---- MCP 命令 ---- */
  ctx.mcpCommands.register({
    name: 'system.settings:set',
    description: '写入设置字段',
    args: {
      key: { type: 'string', description: '设置路径，如 ui.locale' },
      value: { type: 'object', description: '值' },
    },
  })
  ctx.mcpCommands.register({
    name: 'system.layout:set',
    description: '写入布局字段',
    args: {
      key: { type: 'string', description: '布局路径，如 sidebar.width' },
      value: { type: 'object', description: '值' },
    },
  })
  ctx.mcpCommands.register({
    name: 'system.i18n:setLocale',
    description: '切换界面语言',
    args: { locale: { type: 'string', description: '语言码，如 zh-CN / en-US' } },
  })

  /* ---- 命令：设置弹窗（MenuBar 订阅打开） ---- */
  ctx.events.define({ name: `command:${OPEN_SETTINGS_COMMAND}`, description: '打开设置对话框' })
  ctx.commands.onCommand(OPEN_SETTINGS_COMMAND, () => {
    // 订阅方（MenuBar）打开弹窗；这里仅占位，无其它动作
  })

  /* ---- 设置语言联动（settings 字段 ↔ i18n） ---- */
  // 1) 首次拉取完成（system.settings:loaded）时，把持久化的语言应用到 i18n（初始化对齐）
  ctx.events.subscribe(SETTINGS_LOADED, (payload) => {
    const data = (payload ?? {}) as Record<string, unknown>
    const ns = (data as { system?: Record<string, unknown> } | undefined)?.system
    const lang = (ns as { general?: { appearance?: { language?: unknown } } } | undefined)?.general?.appearance?.language
    if (typeof lang === 'string' && lang !== ctx.i18n.getLocale()) {
      ctx.i18n.setLocale(lang)
    }
  })
  // 2) 设置生效（SSE 推回 system.settings:changed）时，实时同步切换界面语言
  ctx.events.subscribe(SETTINGS_CHANGED, (payload) => {
    const { key, value } = (payload ?? {}) as { key?: string; value?: unknown }
    if (key === 'system.general.appearance.language' && typeof value === 'string') {
      ctx.i18n.setLocale(value)
    }
  })
}

/** postInit：settings 域无跨插件联动（占位，保持接口对称） */
export function setupSettings(_ctx: PluginContext): void {
  // 无跨插件联动
}
