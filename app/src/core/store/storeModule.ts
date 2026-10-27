/**
 * store 模块工厂 —— 通用持久化数据域的前端模块（settings / editorState…统一使用）。
 *
 * 架构约定（模块化注册 + 事件驱动 + 防抖批量提交）：
 * - 模块 id 即数据域 domain（如 "settings"），通过 init(ctx) 向注册器注册事件与命令 handler
 * - 维护一份前端 cache（嵌套对象），作为"数据生效"的权威读取源
 * - 变更链路：
 *   前端改字段 → runCommand(`system.<domain>:set`, { key, value })
 *   → 写入本地待提交队列（pending Map，防抖）→ 到点后批量 PUT 到后端
 *   → 后端一次持久化 + SSE 逐条推回 → 本模块收到 SSE 事件 → 更新 cache
 *   → 广播 `system.<domain>:changed`（携带 key）→ 关心该 key 的组件拉 cache 值更新界面
 * - 防抖：快速连续改动只在空闲后提交一次，避免频繁写盘/请求；
 *   页面关闭前 flush（beforeunload）确保不丢未提交变更。
 * - 初始加载：GET 全量 → 写入 cache → 广播 `system.<domain>:loaded`
 *
 * 命名空间：命令/事件名统一加 `system.` 前缀（全局隔离，插件可注册自己的命名空间）。
 */
import { getStore, putStore } from '../../api/client.js'
import { commandEventName } from '../commandBus.js'
import type { Module, ModuleContext } from '../module.js'
import type { IEventBus } from '../types.js'

/* ---------------- 事件契约 ---------------- */

export interface StoreChangedPayload {
  key: string
  value: unknown
}

/** 数据域事件名：`system.<domain>:changed` / `system.<domain>:loaded`（组件订阅时使用） */
export function storeChangedEvent(domain: string): string {
  return `system.${domain}:changed`
}
export function storeLoadedEvent(domain: string): string {
  return `system.${domain}:loaded`
}

/** 数据域命令名：`system.<domain>:set` / `system.<domain>:get` */
export function storeSetCommand(domain: string): string {
  return `system.${domain}:set`
}
export function storeGetCommand(domain: string): string {
  return `system.${domain}:get`
}

/** 防抖延迟（ms）：空闲多久后批量提交 */
export const STORE_FLUSH_DELAY = 300

/* ---------------- settings 域导出（系统命名空间前缀：system.settings:changed/loaded） ---------------- */

export const SETTINGS_CHANGED = storeChangedEvent('settings')
export const SETTINGS_LOADED = storeLoadedEvent('settings')
export const SETTINGS_SET_COMMAND = storeSetCommand('settings')
export type SettingsChangedPayload = StoreChangedPayload
export type SettingsApi = StoreApi

/* ---------------- 工具函数 ---------------- */

function parsePath(path: string): string[] {
  return path
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function getAtPath(root: Record<string, unknown>, segments: string[]): unknown {
  let node: unknown = root
  for (const seg of segments) {
    if (node === undefined || node === null || typeof node !== 'object' || Array.isArray(node)) {
      return undefined
    }
    node = (node as Record<string, unknown>)[seg]
  }
  return node
}

function setAtPath(root: Record<string, unknown>, segments: string[], value: unknown): void {
  let node: Record<string, unknown> = root
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    const next = node[seg]
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      const created: Record<string, unknown> = {}
      node[seg] = created
      node = created
    } else {
      node = next as Record<string, unknown>
    }
  }
  node[segments[segments.length - 1]] = value
}

/* ---------------- 模块公开 API ---------------- */

/** store 模块对外公开 API（挂在 ModuleContext 上，供 SSE 客户端/组件使用） */
export interface StoreApi {
  /** 注入后端 SSE 推回的变更（由 SSE 客户端调用） */
  applyRemoteChange(change: StoreChangedPayload): void
  /**
   * 懒加载（幂等）：首次调用从后端拉全量到 cache 并广播 loaded，
   * 之后直接返回（已加载过则不再拉取）。消费方按需触发，框架不自动调用。
   */
  ensureLoaded(): Promise<void>
  /** 用全量快照重建 cache 并广播加载完成（显式强制重载） */
  load(): Promise<void>
  /** 按点路径读 cache */
  get(key: string): unknown
  /** 立即提交待提交队列（页面关闭 / 主动保存时调用） */
  flush(): Promise<void>
}

/** 扩展的模块上下文：含 store API（由 store 模块 init 时挂载） */
export interface StoreModuleContext extends ModuleContext {
  stores?: Record<string, StoreApi>
}

/* ---------------- 模块工厂 ---------------- */

/**
 * 创建数据域模块（通用持久化流程）。
 * domain：数据域 id，也是后端 REST/SSE 路径段（如 "settings" → /api/settings）。
 * @param opts.syncWriteCache 可选：setCommand 入队时同步写 cache + 广播 changed（不走 SSE 也能让
 *   cache 是权威）。适用于高频本地写入且不需要 SSE 回推同步的域（如 layout：拖拽写入频繁，
 *   SSE 回推会与本地 state 主导的拖拽流程叠加造成卡顿）。默认 false：依赖 SSE 回推写 cache。
 */
export function createStoreModule(domain: string, opts: { syncWriteCache?: boolean } = {}): StoreModule {
  // cache：嵌套对象，对应后端全量结构；a.b.c 路径逐级取值
  let cache: Record<string, unknown> = {}
  let events: IEventBus | undefined
  /** lazy 标志：ensureLoaded 是否已拉取过全量 */
  let loaded = false
  /** 进行中的加载 Promise：并发 ensureLoaded 合并为一次请求 */
  let loadingPromise: Promise<void> | undefined

  // 防抖批量提交队列：key → 待提交值；空闲 STORE_FLUSH_DELAY 后统一 PUT
  const pending = new Map<string, unknown>()
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  const changedEvent = storeChangedEvent(domain)
  const loadedEvent = storeLoadedEvent(domain)
  const setCommand = storeSetCommand(domain)
  const getCommand = storeGetCommand(domain)

  /** 提交 pending 队列（清空 + 批量 PUT） */
  async function flushPending(): Promise<void> {
    if (pending.size === 0) return
    const updates = Array.from(pending.entries()).map(([key, value]) => ({ key, value }))
    pending.clear()
    try {
      await putStore(domain, updates)
      // 后端持久化 + SSE 逐条推回后广播 changed；这里不直接更新 cache，避免与 SSE 回推重复/竞态
    } catch (err) {
      console.error(`[store:${domain}] 批量提交失败:`, err)
      // 提交失败：把待提交项放回队列，等待下次提交或重试
      for (const update of updates) {
        pending.set(update.key, update.value)
      }
      // 失败后仍触发一次重试定时（避免静默丢失）
      scheduleFlush()
    }
  }

  /** 调度防抖提交 */
  function scheduleFlush(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      void flushPending()
    }, STORE_FLUSH_DELAY)
  }

const api: StoreApi = {
    applyRemoteChange(change: StoreChangedPayload): void {
      setAtPath(cache, parsePath(change.key), change.value)
      // 广播放到微任务，避免与 React 渲染同步期重叠（消除"渲染期间更新组件"警告）
      queueMicrotask(() => {
        void events?.emit(changedEvent, change)
      })
    },

    /** 懒加载（幂等）：首次调用拉全量，之后直接返回；并发调用合并为一次请求 */
    ensureLoaded(): Promise<void> {
      if (loaded) return Promise.resolve()
      if (loadingPromise) return loadingPromise
      loadingPromise = api
        .load()
        .then(() => {
          loaded = true
        })
        .finally(() => {
          loadingPromise = undefined
        })
      return loadingPromise
    },

    async load(): Promise<void> {
      const data = await getStore(domain)
      cache = data
      void events?.emit(loadedEvent, data)
    },

    get(key: string): unknown {
      return getAtPath(cache, parsePath(key))
    },

    async flush(): Promise<void> {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      await flushPending()
    },
  }

  const module: StoreModule = {
    id: domain,
    api,

    async init(ctx): Promise<void> {
      events = ctx.events

      // 事件契约
      events.define({
        name: changedEvent,
        description: `${domain} 数据变更：后端 SSE 推回后广播，携带 { key, value }`,
      })
      events.define({
        name: loadedEvent,
        description: `${domain} 数据全量加载完成，携带完整数据对象`,
      })
      // 命令作为事件分发，提前 define 以消除"发布未定义事件"警告
      events.define({ name: commandEventName(setCommand) })
      events.define({ name: commandEventName(getCommand) })

      // 命令：写入（前端改字段的唯一出口）→ 入防抖队列，空闲后批量提交
      ctx.commands.onCommand(setCommand, (args) => {
        const { key, value } = (args ?? {}) as { key?: string; value?: unknown }
        if (!key) {
          console.warn(`[store:${domain}] ${setCommand} 缺少 key`)
          return
        }
        // 覆盖写：同 key 多次变更只保留最后值，且以最后一次为准
        pending.set(key, value)
        // 可选：同步写 cache + 广播 changed（不走 SSE 也能让 cache 是权威）。
        // 适用于高频本地写入且不需要 SSE 回推同步的域（如 layout：拖拽写入频繁，
        // SSE 回推会与本地 state 主导的拖拽流程叠加造成卡顿）。
        if (opts.syncWriteCache) {
          api.applyRemoteChange({ key, value })
        }
        scheduleFlush()
      })

      // 命令：读取 cache（组件"拉取前端 cache 值"）。
      // 注意：CommandBus 异步契约下 handler 返回值不可达，读取仅供后续扩展/调试。
      ctx.commands.onCommand(getCommand, (args) => {
        const { key } = (args ?? {}) as { key?: string }
        if (key) {
          api.get(key)
        }
      })

      // 页面关闭/刷新前 flush，确保未提交变更落盘
      const onBeforeUnload = () => {
        void api.flush()
      }
      window.addEventListener('beforeunload', onBeforeUnload)

      // 把公开 API 挂到上下文，供 SSE 客户端 / 组件触达
      const storeCtx = ctx as StoreModuleContext
      storeCtx.stores = storeCtx.stores ?? {}
      storeCtx.stores[domain] = api
      // 同时挂到服务容器（services.<id>，统一服务发现；core.services 供组件取用）
      storeCtx.services[domain] = api
    },
  }

  return module
}

/** store 模块实例类型：Module + 公开 api（供 appCore 取用） */
export interface StoreModule extends Module {
  api: StoreApi
}
