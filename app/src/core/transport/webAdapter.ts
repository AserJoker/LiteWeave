/**
 * Web 传输适配器 —— 通讯走 HTTP 请求（fetch + EventSource）。
 *
 * 占位实现：当前阶段测试全部走 Electron，Web 是未来移植目标。
 * 协议与 Electron 版完全一致（endpoint + JSON），只是传输底层换成 HTTP：
 * - request → fetch(`${BASE_URL}${path}`)
 * - subscribe → EventSource(`${BASE_URL}${path}`)
 * - invoke → 未来映射为特定 REST endpoint（原生能力在 Web 下不可用）
 *
 * 当大部分功能完成后，做兼容性改造时实现本文件即可，业务层零改动。
 */
import type { TransportAdapter, TransportMethod, Unsubscribe } from './transport.js'

/** Web 适配器（占位）：直接调用会报错，提示未来实现 */
export function createWebAdapter(): TransportAdapter {
  return {
    kind: 'web',

    async request<T = unknown>(_method: TransportMethod, _path: string, _body?: unknown): Promise<T> {
      throw new Error('[transport] Web 适配器尚未实现（未来移植目标）')
    },

    subscribe(_path: string, _cb: (data: unknown) => void): Unsubscribe {
      throw new Error('[transport] Web 适配器尚未实现（未来移植目标）')
    },

    async invoke<T = unknown>(_channel: string, _payload?: unknown): Promise<T> {
      throw new Error('[transport] Web 适配器尚未实现（未来移植目标）')
    },
  }
}
