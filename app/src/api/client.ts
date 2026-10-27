/**
 * LiteWeave 前端 API 客户端。
 *
 * 所有与后端（server/ / 主进程服务层）的交互集中在这里，底层走统一通讯通道
 * （transport：Electron=IPC / Web=HTTP），协议为 endpoint+JSON。
 * 业务层不感知传输差异。
 *
 * 使用：appCore 创建 transport 后调用 bindTransport() 注入；
 * 未注入时抛错（正常流程都会在启动时注入）。
 */
import type { Transport, TransportMethod } from '../core/transport/index.js'

/** 模块内 transport 单例（由 bindTransport 注入） */
let transport: Transport | undefined

/** 注入通讯通道（应用启动时调用一次） */
export function bindTransport(t: Transport): void {
  transport = t
}

function requireTransport(): Transport {
  if (!transport) {
    throw new Error('[client] transport 未注入，请先 bindTransport(core.transport)')
  }
  return transport
}

/** 统一请求封装：REST 语义 + JSON，底层由 transport 决定（IPC / HTTP） */
async function request<T>(method: TransportMethod, path: string, body?: unknown): Promise<T> {
  return requireTransport().request<T>(method, path, body)
}

/** 获取指定数据域的全量快照（通用存储流程） */
export async function getStore(domain: string): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>('GET', `/api/${domain}`)
}

/**
 * 批量写入指定数据域（通用存储流程）。
 * updates: [{key, value}, ...]，后端一次持久化、逐条通知。
 * 返回后端实际产生变更的条目数。
 */
export async function putStore(
  domain: string,
  updates: Array<{ key: string; value: unknown }>,
): Promise<{ ok: boolean; changed: number }> {
  return request<{ ok: boolean; changed: number }>('PUT', `/api/${domain}`, { updates })
}
