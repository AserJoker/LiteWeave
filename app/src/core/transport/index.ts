/**
 * 通讯通道抽象层 —— 统一入口。
 *
 * 运行时检测当前环境（Electron / Web）选择适配器，业务层只面向 Transport 接口。
 * - Electron：IPC 消息（window.liteweave）
 * - Web（未来）：HTTP fetch/EventSource
 *
 * 用法：
 *   import { createTransportForEnv } from './transport/index.js'
 *   const transport = createTransportForEnv()
 *   transport.request('GET', '/api/settings')
 */
import { createTransport, type Transport } from './transport.js'
import { createElectronAdapter, isElectron } from './electronAdapter.js'
import { createWebAdapter } from './webAdapter.js'

export { createTransport } from './transport.js'
export type {
  Transport,
  TransportAdapter,
  TransportMethod,
  Unsubscribe,
} from './transport.js'
export { isElectron, createElectronAdapter } from './electronAdapter.js'
export { createWebAdapter } from './webAdapter.js'

/**
 * 按当前环境创建传输层门面。
 * Electron 下走 IPC；否则用 Web 适配器（当前占位，未来实现）。
 */
export function createTransportForEnv(): Transport {
  if (isElectron()) {
    return createTransport(createElectronAdapter())
  }
  // Web：未来移植目标，当前占位
  return createTransport(createWebAdapter())
}
