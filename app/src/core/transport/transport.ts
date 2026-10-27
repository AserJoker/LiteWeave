/**
 * 通讯通道抽象层 —— 把"前后端通讯"与"业务逻辑"解耦。
 *
 * 设计目标（用户方向）：
 * - 协议统一：**endpoint（URL）+ JSON**，两端一致（REST 语义）
 * - Electron 桌面端：传输走**消息**（主进程 IPC，同进程内存路由，无 Express/HTTP 端口）
 * - Web 端（未来移植目标）：传输走**请求**（HTTP fetch + EventSource）
 * - 业务层（store / project / ai…）只面向统一接口，不感知底层是 IPC 还是 HTTP
 *
 * 当前状态：
 * - ElectronAdapter 已实现（测试全部走 Electron）
 * - WebAdapter 占位（未来大部分功能完成后做兼容性改造再实现）
 *
 * 传输层契约（业务层唯一依赖）：
 * - request(method, path, body?)：REST 语义请求（GET/PUT/POST/DELETE + JSON）
 * - subscribe(path, cb)：订阅服务端推送（SSE 语义；Electron 下经 IPC 事件推送）
 * - invoke(channel, payload?)：命令式调用（原生能力：打开项目/读目录等）
 */

/** REST 方法（与 HTTP 语义对齐，Electron 下透传给主进程服务层） */
export type TransportMethod = 'GET' | 'PUT' | 'POST' | 'DELETE'

/** 推送订阅的取消函数 */
export type Unsubscribe = () => void

/** 传输层适配器接口：所有业务通讯（store 读写 / AI 对话 / 订阅 / 原生能力）都经此接口 */
export interface TransportAdapter {
  readonly kind: 'electron' | 'web'

  /**
   * 通用 REST 语义请求。path 以 /api 开头（如 /api/settings）。
   * 返回解析后的 JSON 响应体（与后端服务层返回一致）。
   */
  request<T = unknown>(method: TransportMethod, path: string, body?: unknown): Promise<T>

  /**
   * 订阅服务端推送（SSE 语义）。path 以 /api 开头（如 /api/settings/events）。
   * 回调收到解析后的数据（如 settings 域 {key, value} 变更）。
   * 返回取消订阅函数。
   */
  subscribe(path: string, cb: (data: unknown) => void): Unsubscribe

  /**
   * 命令式调用（原生能力 / 非 REST 交互）。
   * channel 如 'project:readDir' / 'project:open'。
   * 返回主进程处理结果。
   */
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>
}

/** 传输层便捷门面：把 adapter 暴露成直调方法 */
export interface Transport {
  readonly adapter: TransportAdapter
  request<T = unknown>(method: TransportMethod, path: string, body?: unknown): Promise<T>
  subscribe(path: string, cb: (data: unknown) => void): Unsubscribe
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>
}

/** 创建传输门面（包一层 adapter，调用方不必关心 adapter 形状） */
export function createTransport(adapter: TransportAdapter): Transport {
  return {
    adapter,
    request: (m, p, b) => adapter.request(m, p, b),
    subscribe: (p, cb) => adapter.subscribe(p, cb),
    invoke: (c, p) => adapter.invoke(c, p),
  }
}
