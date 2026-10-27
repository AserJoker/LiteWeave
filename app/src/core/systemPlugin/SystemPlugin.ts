/**
 * SystemPlugin —— 系统内置插件的类封装。
 *
 * 设计（见 docs/design/plugin-system.md §6）：
 * 系统本身视作一个内置插件，与第三方插件走完全同一条链路（register → start）。
 * 一个插件 = 一个端到端业务域：这里把系统全部资源按业务域拆分到多个文件，
 * 每个业务域文件导出 register*(ctx) 函数收拢该域的 schema/资源类型/编辑器/菜单/MCP 命令。
 *
 * 三级生命周期：
 * - preInit：注册数据域子模块（settings/layout/project/history）—— 不引用其它插件资源
 * - init：调用各业务域 register* 完成资源注册 + 订阅
 * - postInit：调用各业务域 setup* 完成跨插件联动（历史注册、schema patch）
 *
 * 单例：导出 systemPlugin = new SystemPlugin()（见 index.ts）。
 */
import type { Plugin, PluginContext } from '../module.js'
import { createStoreModule } from '../store/storeModule.js'
import { createProjectModule } from '../project/projectModule.js'
import { createHistoryModule } from '../history/historyModule.js'
import { registerMenus } from './menus.js'
import { registerProject, setupProject } from './project.js'
import { registerLang, setupLang } from './lang.js'
import { registerHistory, setupHistory } from './history.js'
import { registerSettings, setupSettings } from './settings.js'
import { registerRunner, setupRunner } from '../runner/runnerService.js'

/**
 * 系统内置插件：承载全部系统资源注册。
 *
 * 内部组织：preInit 注册子模块；init/postInit 按业务域调用 register / setup 函数。
 * 业务域文件按"内聚"原则划分（project / lang / history / settings / demo + 跨域 menus）。
 */
export class SystemPlugin implements Plugin {
  readonly id = 'system'
  readonly version = '0.1.0'

  async preInit(ctx: PluginContext): Promise<void> {
    // 一级：注册数据域子模块（不引用其它插件资源），使宿主 init 批量能调度它们的 init。
    await ctx.modules.register(createStoreModule('settings'))
    // layout 走"主动拉取 + 只写"模式：setCommand 入队时同步写 cache + 广播 changed，
    // 不依赖 SSE 回推（拖拽高频变更，SSE 回推会与本地 state 主导的拖拽流程叠加造成卡顿）。
    // App.tsx 不为 layout 连 SSE，services.js wireStorePush 也不接 layout。
    await ctx.modules.register(createStoreModule('layout', { syncWriteCache: true }))
    await ctx.modules.register(createProjectModule())
    await ctx.modules.register(createHistoryModule())
  }

  async init(ctx: PluginContext): Promise<void> {
    // 二级：按业务域注册资源 + 订阅（子模块 init 已由宿主在 init 批量阶段统一调度）
    registerProject(ctx)
    registerLang(ctx)
    registerHistory(ctx)
    registerSettings(ctx)
    registerRunner(ctx)
    registerMenus(ctx)
  }

  async postInit(ctx: PluginContext): Promise<void> {
    // 三级：跨插件联动（所有插件 init 完成后执行）
    setupProject(ctx)
    setupLang(ctx)
    setupHistory(ctx)
    setupSettings(ctx)
    setupRunner(ctx)
  }
}
