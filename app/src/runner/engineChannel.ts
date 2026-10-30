/**
 * Worker 侧通讯层封装。
 *
 * 职责：
 * - 管理 req/res（自动分配消息 id，等待主线程 response）
 * - 发送 frame（命令缓冲区批量提交）
 * - 握手协议（ready → 等 cleared → resolve）
 * - 接收主线程通知（cleared/warn/error 回调）
 *
 * engine API 内部用此通道，业务脚本不直接接触（脚本只调 engine.* 命令式 API）。
 *
 * 详见 docs/design/engine-redesign.md §4、§5。
 */
import type {
  RequestMessage,
  ResponseMessage,
  NotifyMessage,
  EventPayload,
  FrameMessage,
  Command,
  ReadFilePayload,
  LoadAssetsPayload,
  ReadScriptPayload,
} from './protocol'

/** 主线程响应 payload 类型映射（成功时的纯数据类型；失败走 reject） */
interface ResponsePayloads {
  readFile: Uint8Array
  loadAssets: Record<string, Uint8Array | { error: string }>
  readScript: string
}

type RequestType = keyof ResponsePayloads

/** pending 请求表（id → resolver） */
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

/** 消息 id 自增 */
let nextReqId = 1

/** cleared 握手 resolver（ready 发出后等 cleared） */
let clearedResolve: (() => void) | null = null

/** 通知回调（外部注册，处理 cleared/warn/error） */
let notifyHandler: ((msg: NotifyMessage) => void) | null = null

/** 事件总线：event 名 → listener 集合（engine.on 注册） */
const eventListeners = new Map<string, Set<(data: unknown) => void>>()
/** 早期事件缓存：event 名 → 最近一次 data（事件早于 engine.on 注册时缓存，注册时回放） */
const earlyEventCache = new Map<string, unknown>()

/** 注册主线程通知回调 */
export function setNotifyHandler(handler: ((msg: NotifyMessage) => void) | null): void {
  notifyHandler = handler
}

/** 订阅主线程事件（engine.on 内部调用）。返回 unsubscribe。早期缓存命中时立即回放一次。 */
export function onEvent(event: string, cb: (data: unknown) => void): () => void {
  let set = eventListeners.get(event)
  if (!set) {
    set = new Set()
    eventListeners.set(event, set)
  }
  set.add(cb)
  // 早期事件回放：事件在 on 注册前到达，缓存最近一次 data 立即投递
  if (earlyEventCache.has(event)) {
    cb(earlyEventCache.get(event))
  }
  return () => {
    const s = eventListeners.get(event)
    if (s) {
      s.delete(cb)
      if (s.size === 0) eventListeners.delete(event)
    }
  }
}

/** 监听主线程消息（Worker 入口调用一次） */
self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as ResponseMessage | NotifyMessage
  if (msg.kind === 'response') {
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.ok) {
      entry.resolve(msg.payload)
    } else {
      entry.reject(new Error(msg.error ?? 'unknown error'))
    }
    return
  }
  if (msg.kind === 'notify') {
    if (msg.type === 'cleared' && clearedResolve) {
      const r = clearedResolve
      clearedResolve = null
      r()
      return
    }
    if (msg.type === 'event') {
      // 主线程事件 → 分发给已注册 listener；无 listener 时缓存最近值（engine.on 注册时回放）
      const p = msg.payload as EventPayload
      if (p && typeof p.event === 'string') {
        earlyEventCache.set(p.event, p.data)
        const set = eventListeners.get(p.event)
        if (set) for (const cb of set) cb(p.data)
      }
      return
    }
    if (notifyHandler) notifyHandler(msg)
    return
  }
}

/** 发送握手 ready，等主线程 cleared */
export function waitReady(): Promise<void> {
  return new Promise((resolve) => {
    clearedResolve = resolve
    const ready = { kind: 'ready' as const }
    ;(self as unknown as Worker).postMessage(ready)
  })
}

/** 发送 req/res 请求，等主线程 response */
export function request<T extends RequestType>(
  type: T,
  payload: T extends 'readFile' ? ReadFilePayload : T extends 'readScript' ? ReadScriptPayload : LoadAssetsPayload,
): Promise<ResponsePayloads[T]> {
  const id = nextReqId++
  const msg: RequestMessage = { kind: 'request', id, type, payload } as RequestMessage
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    ;(self as unknown as Worker).postMessage(msg)
  })
}

/** 发送 frame（命令缓冲区批量提交） */
export function sendFrame(commands: Command[]): void {
  const msg: FrameMessage = { kind: 'frame', commands }
  // 不 transfer：view/projection 等小矩阵每帧复用同一 Float32Array 引用，
  // transfer 会 detach 原始 buffer 致下一帧 DOMException。结构化克隆拷贝代价可忽略。
  // （动态资产 writeDynamicBuffer 的大 ArrayBuffer 未来需要 transfer 优化，当前 demo 不用。）
  ;(self as unknown as Worker).postMessage(msg)
}
