/**
 * engine 通讯协议类型（Worker ↔ 渲染主线程 共享）。
 *
 * 三类消息：
 * - request/response：Worker → 主线程，带消息 id 等待 ack（readFile/loadAssets）
 * - frame：Worker → 主线程，命令缓冲区批量提交（commit 触发）
 * - notify：主线程 → Worker，单向通知（cleared 握手 ack / warn / error）
 * - ready：Worker → 主线程，握手启动信号（特殊，无 id）
 *
 * 详见 docs/design/engine-redesign.md §4 通讯协议。
 */

/** Worker → 主线程：握手启动信号（特殊，无 id） */
export interface ReadyMessage {
  kind: 'ready'
}

/** Worker → 主线程：请求（带消息 id，等 response） */
export interface RequestMessage {
  kind: 'request'
  id: number
  type: 'readFile' | 'loadAssets' | 'readScript'
  payload: ReadFilePayload | LoadAssetsPayload | ReadScriptPayload
}

export interface ReadFilePayload {
  projectId: string
  assetId: string
}

export interface LoadAssetsPayload {
  projectId: string
  assetIds: string[]
}

export interface ReadScriptPayload {
  projectId: string
  path: string // 项目根相对路径（如 dist/main.js）
}

/** 主线程 → Worker：响应（配对 request id） */
export interface ResponseMessage {
  kind: 'response'
  id: number
  ok: boolean
  payload?: unknown
  error?: string
}

/** Worker → 主线程：命令缓冲区批量提交（commit 触发） */
export interface FrameMessage {
  kind: 'frame'
  commands: Command[]
}

/** 主线程 → Worker：单向通知 */
export interface NotifyMessage {
  kind: 'notify'
  type: 'cleared' | 'warn' | 'error' | 'event'
  payload?: unknown
}

/** event 通知的 payload 结构（type='event' 时） */
export interface EventPayload {
  event: string
  data?: unknown
}

export type WorkerToMain = ReadyMessage | RequestMessage | FrameMessage
export type MainToWorker = ResponseMessage | NotifyMessage

/** 命令（frame 内，commit 校验后发） */
export type Command =
  | { op: 'addRO'; name: string; modelId: string; materialId: string; pipelineBindings: Record<string, Record<string, string>>; initialFields?: Record<string, Float32Array> }
  | { op: 'removeRO'; name: string }
  | { op: 'setField'; name: string; field: string; value: Float32Array }
  | { op: 'lockRO'; name: string }
  | { op: 'unlockRO'; name: string }
  | { op: 'setViewProjection'; view: Float32Array; projection: Float32Array }
  | { op: 'createDynamicBuffer'; id: string; size: number; usage: number }
  | { op: 'writeDynamicBuffer'; id: string; data: ArrayBuffer }
  | { op: 'destroyDynamicBuffer'; id: string }
