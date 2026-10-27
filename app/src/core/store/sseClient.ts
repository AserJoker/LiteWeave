/**
 * 前端订阅客户端 —— 订阅指定数据域的后端变更推送（通用持久化流程）。
 *
 * 链路：后端 store 变更 → 推送（Electron=IPC / Web=SSE）→ 本客户端收到
 * → 调用 store.applyRemoteChange 更新 cache 并广播 ${domain}:changed。
 *
 * 底层走统一通讯通道 transport.subscribe（Electron=IPC / Web=EventSource），
 * 协议与语义一致，业务层不感知传输差异。
 */
import type { Transport, Unsubscribe } from '../transport/index.js'
import type { StoreApi, StoreChangedPayload } from './storeModule.js'

/** 建立订阅连接；返回断开函数。store 未挂载时返回空操作。 */
export function connectStoreSSE(domain: string, store: StoreApi | undefined, transport?: Transport): () => void {
  if (!store) {
    console.warn(`[store-sse] ${domain} 模块未挂载，跳过订阅`)
    return () => {}
  }
  if (!transport) {
    console.warn(`[store-sse] ${domain} 无 transport，跳过订阅`)
    return () => {}
  }

  let unsub: Unsubscribe = () => {}
  try {
    unsub = transport.subscribe(`/api/${domain}/events`, (data) => {
      try {
        const change = data as StoreChangedPayload
        store.applyRemoteChange(change)
      } catch (err) {
        console.error(`[store-sse] 解析推送数据失败:`, err, data)
      }
    })
  } catch (err) {
    console.error(`[store-sse] ${domain} 订阅失败:`, err)
  }

  return () => {
    unsub()
  }
}
