/**
 * 应用级 core 单例 —— 前端启动时的框架装配点。
 *
 * 职责：
 * - createCore()：创建事件总线 + 命令总线 + 各注册器（含 5 个新注册器）
 * - 注册系统内置插件（systemPlugin）：系统全部资源（数据域模块/schema/渲染器/
 *   资源类型/编辑器/面板/菜单/MCP 命令）收敛进一个插件，走完整插件流程
 * - plugins.start()：三级生命周期（preInit→init→postInit）+ 宿主就绪动作
 *   （onReady 聚合回传 MCP 命令清单到主进程）
 * - 把各数据域模块的公开 API 挂到 core 上（组件/SSE 客户端取用）
 * - 注意：不自动调用 ensureLoaded/load —— 首次拉取是 lazy 的，由消费方按需触发
 *   （如 SettingsDialog 打开时 ensureLoaded()）。框架只装配，不主动拉数据。
 */
import { createCore, type Core } from './index.js'
import type { StoreApi } from './store/storeModule.js'
import type { ProjectApi } from './project/projectModule.js'
import type { HistoryApi } from './history/historyModule.js'
import type { RunnerApi } from './runner/runnerService.js'
import { bindTransport } from '../api/client.js'
import { subscribeMcpCommands } from './mcp/mcpClient.js'
import { systemPlugin } from './systemPlugin/index.js'

export interface AppCore extends Core {
  /** settings 数据域公开 API（cache 读取 + 远程变更注入 + 懒加载 + 防抖批量提交） */
  settings: StoreApi
  /** layout 数据域公开 API（面板容器归属 / 开关 / 宽度 / 激活面板持久化） */
  layout: StoreApi
  /** project 数据域公开 API（项目管理：list/create/open/close/import/export/remove） */
  project: ProjectApi
  /** history 会话级历史 API（文件路径 → 历史栈；编辑器接入 undo/redo） */
  history: HistoryApi
  /** runner 服务 API（启动/停止/重载 Runner 窗口；订阅状态变化与 console 日志） */
  runner: RunnerApi
}

export async function createAppCore(): Promise<AppCore> {
  // 宿主就绪动作：聚合 MCP 命令清单回传主进程（命令元数据前端注册，单一来源）
  const core = createCore({
    onReady: async (ctx) => {
      // 回传主进程：主进程收到后注册/更新为独立 MCP 工具（幂等：已注册跳过）
      void ctx.transport.invoke('mcp:commands:sync', { commands: ctx.mcpCommands.list() }).catch((err) => {
        console.error('[mcp] 回传命令清单失败:', err)
      })
    },
  })

  // 注入通讯通道到 api client（Electron=IPC / Web=HTTP，业务层经统一接口交互）
  bindTransport(core.transport)

  // 系统内置插件：注册（只登记）→ 启动（三级生命周期 + 宿主就绪回传 MCP 命令清单）
  await core.plugins.register(systemPlugin)
  await core.plugins.start()

  // 把 settings / layout / project api 挂到 core，供组件 / SSE 客户端触达
  const appCore = core as AppCore
  appCore.settings = core.services['settings'] as StoreApi
  appCore.layout = core.services['layout'] as StoreApi
  appCore.project = core.services['project'] as ProjectApi
  appCore.history = core.services['history'] as HistoryApi
  appCore.runner = core.services['runner'] as RunnerApi

  // MCP 命令落地：agent 经 MCP 触发的命令 → 走统一命令通道（与人工操作同链路）。
  // 模块已全部注册，命令 handler 就绪；未知命令由 CommandBus 宽松兜底（emit 无监听器不报错）。
  subscribeMcpCommands(({ command, args }) => {
    void core.commands.runCommand(command, args).catch((err) => {
      console.error(`[mcp] 执行命令失败 ${command}:`, err)
    })
  })

  return appCore
}
