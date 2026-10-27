/**
 * runner 服务 —— IDE 侧对 Runner 窗口的控制柄。
 *
 * 定位（见 docs/design/monaco-tsserver.md §10 双窗口模型）：
 * Runner 是独立 Electron 进程，IDE 不直连它，全部经主进程中转：
 *   IDE ──transport.invoke('runner:start')──► 主进程 ──webContents──► Runner
 *   Runner ──ipc──► 主进程 ──webContents.send('runner:event')──► IDE（本服务订阅）
 *
 * 本服务职责：
 * - 暴露 start/stop/reload/getStatus API（命令通道 + 直接调用均可）
 * - 订阅主进程推送的 runner:event（状态变化 / console 日志 / 心跳），维护本地 status 镜像
 * - 广播 system.runner:status-changed 事件（Toolbar 状态指示器订阅刷新）
 *
 * 不做完整 Plugin 模块的原因：
 * - 无持久化状态（Runner 进程级资源，主进程权威）
 * - 无 store/sse（不走数据域推送）
 * - 简单有状态服务即可；通过 registerRunner(ctx) 在 systemPlugin.init 注册
 */
import type { PluginContext } from '../module.js'
import { systemCommand } from '../namespace.js'
import type { Transport } from '../transport/index.js'
import type { IEventBus } from '../types.js'

/* ---------------- 类型 ---------------- */

/** Runner 进程状态（与主进程 RunnerStatus 对齐） */
export type RunnerStatus = 'stopped' | 'starting' | 'ready' | 'running' | 'error'

/** Runner 当前状态快照（runner:status 返回） */
export interface RunnerStatusSnapshot {
  status: RunnerStatus
  projectId: string | null
  projectName: string | null
  projectRoot: string | null
  entryScene: string | null
  entryScript: string | null
  alive: boolean
}

/** Runner 启动参数（runner:start） */
export interface RunnerStartArgs {
  projectId?: string
  projectName?: string
  projectRoot?: string
  entryScene?: string
  entryScript?: string
}

/** Runner 控制台日志条目（主进程转发） */
export interface RunnerConsoleEntry {
  level: string
  message: string
  line?: number
  source?: string
}

/** 状态变化事件载荷 */
export interface RunnerStatusChangedPayload {
  status: RunnerStatus
  info?: unknown
  at: string
}

/* ---------------- 事件名 / 命令名 ---------------- */

/** Runner 状态变化事件（system.runner:status-changed） */
export const RUNNER_STATUS_CHANGED = systemCommand('runner:status-changed')
/** Runner 控制台日志事件（system.runner:console） */
export const RUNNER_CONSOLE = systemCommand('runner:console')
/** 启动 Runner 命令（system.runner:start） */
export const RUNNER_START_COMMAND = systemCommand('runner:start')
/** 停止 Runner 命令（system.runner:stop） */
export const RUNNER_STOP_COMMAND = systemCommand('runner:stop')
/** 重载 Runner 命令（system.runner:reload） */
export const RUNNER_RELOAD_COMMAND = systemCommand('runner:reload')

/* ---------------- 服务实现 ---------------- */

/** Runner 服务接口（挂 services['runner']） */
export interface RunnerApi {
  /** 启动 Runner（缺省 projectId 时用当前打开项目） */
  start(args?: RunnerStartArgs): Promise<{ ok?: boolean; error?: string; status?: RunnerStatusSnapshot }>
  /** 停止 Runner */
  stop(): Promise<{ ok?: boolean; error?: string }>
  /** 重载 Runner */
  reload(): Promise<{ ok?: boolean; error?: string; status?: RunnerStatusSnapshot }>
  /** 查询当前状态快照 */
  getStatus(): Promise<RunnerStatusSnapshot>
  /** 当前本地镜像状态（同步；订阅 status-changed 后立即取可用） */
  currentStatus(): RunnerStatus
  /** 订阅状态变化 */
  subscribe(listener: (payload: RunnerStatusChangedPayload) => void): () => void
  /** 订阅 Runner 控制台日志 */
  subscribeConsole(listener: (entry: RunnerConsoleEntry) => void): () => void
}

/** 创建 runner 服务。需在 registerRunner(ctx) 中调用，注入 transport/events。 */
function createRunnerService(transport: Transport, events: IEventBus): RunnerApi {
  const statusListeners = new Set<(p: RunnerStatusChangedPayload) => void>()
  const consoleListeners = new Set<(e: RunnerConsoleEntry) => void>()
  let current: RunnerStatus = 'stopped'

  /** 处理主进程推送的 runner:event */
  function handleEvent(event: { type: string; status?: RunnerStatus; info?: unknown; entry?: RunnerConsoleEntry; at?: string }) {
    if (!event || typeof event !== 'object') return
    if (event.type === 'status' && event.status) {
      current = event.status
      const payload: RunnerStatusChangedPayload = {
        status: event.status,
        info: event.info,
        at: event.at ?? new Date().toISOString(),
      }
      // 广播到框架事件总线（Toolbar 等组件订阅）
      void events.emit(RUNNER_STATUS_CHANGED, payload)
      // 同时通知直接订阅者
      for (const l of statusListeners) {
        try { l(payload) } catch (err) { console.error('[runner] 状态订阅回调异常:', err) }
      }
    } else if (event.type === 'console' && event.entry) {
      void events.emit(RUNNER_CONSOLE, event.entry)
      for (const l of consoleListeners) {
        try { l(event.entry) } catch (err) { console.error('[runner] console 订阅回调异常:', err) }
      }
    }
  }

  /** 订阅主进程推送（仅 Electron 环境；Web 模式无 Runner） */
  function subscribeTransport() {
    if (transport.adapter.kind !== 'electron') return
    // transport.subscribe 是 SSE 语义（path），不适合自定义 channel；
    // 直接走 preload 暴露的 invoke 桥的 onEvent 不存在（IDE preload 没暴露 runner:event 订阅）。
    // 解决：通过 ipcRenderer.on('runner:event') 直接订阅。
    // 但 transport 抽象不暴露 ipcRenderer；这里通过 invoke 不可，需要新加一个 transport 能力。
    // 简化：在 electronAdapter 之外，直接用 window.liteweave.invoke 不行（invoke 是请求-响应）。
    // 折中：主进程已通过 webContents.send('runner:event') 推送，渲染进程需要 ipcRenderer.on。
    // 在 preload.cjs 暴露 onRunnerEvent 桥，本服务调用之。
    const w = window as unknown as { liteweave?: { onRunnerEvent?: (cb: (e: unknown) => void) => () => void } }
    if (typeof w.liteweave?.onRunnerEvent === 'function') {
      return w.liteweave.onRunnerEvent((e) => handleEvent(e as ReturnType<typeof handleEvent> extends never ? never : { type: string; status?: RunnerStatus; info?: unknown; entry?: RunnerConsoleEntry; at?: string }))
    }
    return () => {}
  }

  let unsubTransport: (() => void) | null = null

  return {
    async start(args) {
      if (transport.adapter.kind !== 'electron') {
        return { error: 'not-in-electron' }
      }
      const r = await transport.invoke<{ ok?: boolean; error?: string; status?: RunnerStatusSnapshot }>('runner:start', args ?? {})
      if (r?.status) current = r.status.status
      return r
    },
    async stop() {
      if (transport.adapter.kind !== 'electron') return { error: 'not-in-electron' }
      return await transport.invoke<{ ok?: boolean; error?: string }>('runner:stop')
    },
    async reload() {
      if (transport.adapter.kind !== 'electron') return { error: 'not-in-electron' }
      const r = await transport.invoke<{ ok?: boolean; error?: string; status?: RunnerStatusSnapshot }>('runner:reload')
      if (r?.status) current = r.status.status
      return r
    },
    async getStatus() {
      if (transport.adapter.kind !== 'electron') {
        return { status: current, projectId: null, projectName: null, projectRoot: null, entryScene: null, entryScript: null, alive: false }
      }
      return await transport.invoke<RunnerStatusSnapshot>('runner:status')
    },
    currentStatus() {
      return current
    },
    subscribe(listener) {
      statusListeners.add(listener)
      return () => { statusListeners.delete(listener) }
    },
    subscribeConsole(listener) {
      consoleListeners.add(listener)
      return () => { consoleListeners.delete(listener) }
    },
    // 内部钩子：由 registerRunner 在 init 时调用一次，绑定 transport 订阅
    _bind() {
      if (unsubTransport) return
      unsubTransport = subscribeTransport() ?? null
    },
  } as RunnerApi & { _bind: () => void }
}

/* ---------------- 系统插件接入 ---------------- */

/** init：注册 runner 服务 + 命令 + MCP 命令元数据 + 事件契约 */
export function registerRunner(ctx: PluginContext): void {
  // 事件契约
  ctx.events.define({ name: RUNNER_STATUS_CHANGED, description: 'Runner 窗口状态变化，携带 { status, info?, at }' })
  ctx.events.define({ name: RUNNER_CONSOLE, description: 'Runner 控制台日志，携带 { level, message, line?, source? }' })

  // 创建服务实例（单例）
  const api = createRunnerService(ctx.transport, ctx.events)
  ;(api as RunnerApi & { _bind: () => void })._bind()
  ctx.services['runner'] = api

  // 命令：人工操作 / AI 指令统一走这里
  ctx.commands.onCommand(RUNNER_START_COMMAND, (args) => {
    void api.start((args ?? {}) as RunnerStartArgs).catch((err) => {
      console.error('[runner] start 命令失败:', err)
    })
  })
  ctx.commands.onCommand(RUNNER_STOP_COMMAND, () => {
    void api.stop().catch((err) => console.error('[runner] stop 命令失败:', err))
  })
  ctx.commands.onCommand(RUNNER_RELOAD_COMMAND, () => {
    void api.reload().catch((err) => console.error('[runner] reload 命令失败:', err))
  })

  // MCP 命令元数据（聚合回传主进程注册为 MCP 工具）
  ctx.mcpCommands.register({
    name: 'system.runner:start',
    description: '启动 Runner 窗口（独立进程，承载引擎业务层主循环）。缺省 projectId 时用当前打开项目。',
    args: {
      projectId: { type: 'string', optional: true, description: '项目 id（缺省=当前打开项目）' },
      projectName: { type: 'string', optional: true, description: '项目名（缺省自动补全）' },
      projectRoot: { type: 'string', optional: true, description: '项目根目录绝对路径（缺省自动补全）' },
      entryScene: { type: 'string', optional: true, description: '入口场景资源 id' },
      entryScript: { type: 'string', optional: true, description: '入口脚本路径' },
    },
  })
  ctx.mcpCommands.register({ name: 'system.runner:stop', description: '停止 Runner 窗口（关闭进程）' })
  ctx.mcpCommands.register({ name: 'system.runner:reload', description: '重载 Runner（保留窗口，重新加载页面 + 重注入 bootstrap）' })
  ctx.mcpCommands.register({ name: 'system.runner:status', description: '查询 Runner 当前状态' })
}

/** postInit：runner 域无跨插件联动（占位，保持接口对称） */
export function setupRunner(_ctx: PluginContext): void {
  // 无跨插件联动
}
