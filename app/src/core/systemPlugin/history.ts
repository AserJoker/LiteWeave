/**
 * history 业务域 —— 历史操作命令与 project.json 历史注册。
 *
 * 内容：
 * - 侧边栏面板：历史（右侧）
 * - MCP 命令：撤销/重做/回到指定历史点
 * - postInit：注册 project.json 历史命令监听（模块级，不依赖编辑器组件挂载）
 *
 * 注意：必须在 postInit——history 子模块虽在 preInit 注册，但其 init 由宿主批量调度，
 *      到本插件 init 执行时 services['history'] 尚未挂载（会读到 undefined）。
 */
import type { PluginContext } from '../module.js'
import type { HistoryApi } from '../history/historyModule.js'
import { registerProjectConfigHistory } from '../project/projectConfigHistory.js'
import { HistoryPanel } from '../../components/Sidebar/HistoryPanel.js'

/** init：注册历史面板 + 历史 MCP 命令 */
export function registerHistory(ctx: PluginContext): void {
  /* ---- 侧边栏面板：历史（右） ---- */
  ctx.panels.register({
    id: 'history',
    titleKey: 'system.history.title',
    icon: 'history',
    component: HistoryPanel,
    side: 'right',
  })

  /* ---- MCP 命令：历史操作（撤销 / 重做 / 回退到指定历史点） ---- */
  ctx.mcpCommands.register({
    name: 'system.history:undo',
    description: '撤销当前活动编辑器上一步修改（path 缺省用当前活动文件）',
    args: { path: { type: 'string', optional: true, description: '目标文件路径（缺省当前活动文件）' } },
  })
  ctx.mcpCommands.register({
    name: 'system.history:redo',
    description: '重做当前活动编辑器已撤销的修改（path 缺省用当前活动文件）',
    args: { path: { type: 'string', optional: true, description: '目标文件路径（缺省当前活动文件）' } },
  })
  ctx.mcpCommands.register({
    name: 'system.history:seek',
    description: '一键回到指定历史点（不清理后续历史；新编辑才截断）',
    args: {
      itemId: { type: 'string', description: '历史项 id（从历史面板/历史查询获取）' },
      path: { type: 'string', optional: true, description: '目标文件路径（缺省当前活动文件）' },
    },
  })
}

/** postInit：注册 project.json 历史命令监听（模块级，不依赖编辑器组件挂载） */
export function setupHistory(ctx: PluginContext): void {
  const historyApi = ctx.services['history'] as HistoryApi
  registerProjectConfigHistory(ctx.commands, historyApi)
}
