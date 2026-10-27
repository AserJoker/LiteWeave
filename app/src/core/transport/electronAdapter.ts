/**
 * Electron 传输适配器 —— 通讯走主进程 IPC（消息），协议保持 endpoint+JSON。
 *
 * window.liteweave 由 preload contextBridge 暴露：
 * - request(method, path, body) → ipcRenderer.invoke('transport:request')
 * - subscribe(path, cb) → 注册订阅，返回 { id, unsubscribe }；主进程变更经 transport:event 推送
 * - invoke(channel, payload) → ipcRenderer.invoke(channel)（原生能力）
 *
 * 与 Web 版（webAdapter）的唯一差异在传输实现，协议/接口完全一致。
 */
import type { TransportAdapter, TransportMethod, Unsubscribe } from './transport.js'

/** preload 暴露的桥接口（与 desktop/src/preload.js 契约一致） */
interface LiteweaveBridge {
  request(method: string, path: string, body?: unknown): Promise<unknown>
  subscribe(path: string, cb: (data: unknown) => void): { id: string; unsubscribe: () => void }
  invoke(channel: string, payload?: unknown): Promise<unknown>
}

function getBridge(): LiteweaveBridge | undefined {
  const w = window as unknown as { liteweave?: LiteweaveBridge }
  return w.liteweave
}

/** 检测当前是否运行在 Electron（有 preload 桥） */
export function isElectron(): boolean {
  return typeof getBridge()?.request === 'function'
}

export function createElectronAdapter(): TransportAdapter {
  const bridge = getBridge()
  if (!bridge) {
    throw new Error('[transport] Electron 适配器初始化失败：window.liteweave 不可用')
  }

  return {
    kind: 'electron',

    async request<T = unknown>(method: TransportMethod, path: string, body?: unknown): Promise<T> {
      const result = (await bridge.request(method, path, body)) as T | { error?: string }
      // 主进程错误以 { error } 返回，这里转成异常，业务层与 fetch 语义一致
      if (
        result !== null &&
        typeof result === 'object' &&
        'error' in (result as object) &&
        typeof (result as { error?: string }).error === 'string'
      ) {
        throw new Error((result as { error: string }).error)
      }
      return result as T
    },

    subscribe(path: string, cb: (data: unknown) => void): Unsubscribe {
      const sub = bridge.subscribe(path, cb)
      return sub.unsubscribe
    },

    async invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
      return (await bridge.invoke(channel, payload)) as T
    },
  }
}
