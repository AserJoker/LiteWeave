/**
 * lang 业务域 —— .lang 语言文件资源。
 *
 * 内容：
 * - 资源类型 + 编辑器：.lang → LangEditor
 * - postInit：注册 .lang 历史命令监听（与 projectConfig 历史并行，path 互斥）
 *
 * 注意：.lang 资源的 CRUD/创建校验/删除联动由 project 模块 + 主进程 ProjectManager 承载，
 *      MCP 命令复用 project 域的 system.resource:* ；本域只负责资源类型声明 + 编辑器 + 历史。
 */
import type { PluginContext } from '../module.js'
import type { HistoryApi } from '../history/historyModule.js'
import { LANG_RESOURCE_TYPE, LANG_RESOURCE_TYPE_DEF } from '../resources/resourceTypes.js'
import { LangEditor, registerLangHistory } from '../../components/editors/LangEditor.js'

/** init：注册 .lang 资源类型 + 编辑器 */
export function registerLang(ctx: PluginContext): void {
  ctx.resourceTypes.register(LANG_RESOURCE_TYPE_DEF)
  ctx.editors.register(LANG_RESOURCE_TYPE, ({ tab }) => <LangEditor path={tab.path} />)
}

/** postInit：注册 .lang 历史命令监听（与 projectConfigHistory 并行，path 互斥） */
export function setupLang(ctx: PluginContext): void {
  const historyApi = ctx.services['history'] as HistoryApi
  registerLangHistory(ctx.commands, historyApi)
}
