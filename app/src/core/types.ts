/**
 * 事件驱动底层 —— 核心类型定义。
 *
 * LiteWeave 整套系统以事件总线为核心（见项目架构约定“事件驱动底层 + 命令驱动上层”）。
 * 事件可能由各模块（编辑器、资源、设置、AI 指令…）注册，因此事件名与载荷
 * 无法在编译期静态枚举，这里采用：
 *   - 载荷类型用 unknown（由模块自己声明，运行时校验）
 *   - 模块注册事件时可提供 schema，在 emit 时做运行时校验，校验失败抛错
 *
 * 校验器采用最小接口（Validator），模块可用 zod / 手写函数等任意实现，
 * 未来可统一为某种 schema 协议（如 zod 或 JSON Schema）。
 */

/**
 * 载荷校验器：返回 null 表示通过，返回字符串表示错误信息。
 * 模块可用 zod 的 safeParse 封装，或手写简单函数。
 */
export type Validator = (payload: unknown) => string | null

/**
 * 事件定义：模块注册事件时声明的契约。
 * - name：全局唯一的事件名（建议用命名空间风格，系统内置加 system 前缀，如 "system.settings:changed"；插件用各自命名空间）
 * - schema：可选，运行时校验载荷；不提供则不做校验
 * - description：可选，便于调试与文档
 */
export interface EventDefinition {
  readonly name: string
  readonly schema?: Validator
  readonly description?: string
}

/**
 * 事件监听器。
 * - payload：事件载荷，模块应自行断言为声明类型
 * - 返回 Promise 时，EventBus 会 await 但不影响其它监听器（并行/串行由实现决定）
 */
export type EventListener = (payload: unknown) => void | Promise<void>

/**
 * 取消订阅函数：调用后该监听器不再接收事件。
 */
export type Unsubscribe = () => void

/**
 * 事件总线接口。
 * 各模块持有同一总线实例（或从容器取），通过它通信，模块间不直接引用。
 */
export interface IEventBus {
  /**
   * 注册一个事件定义（声明事件存在及其载荷校验规则）。
   * 重复注册同名事件时，后注册的 schema 覆盖前一个（并 console.warn 提示）。
   */
  define(event: EventDefinition): void

  /**
   * 订阅事件。返回取消订阅函数。
   * 监听器抛错会被捕获并 console.error，不影响其它监听器（错误隔离）。
   */
  subscribe(eventName: string, listener: EventListener): Unsubscribe

  /**
   * 发布事件。载荷会先按事件定义的 schema 校验（若已定义）。
   * 监听器按订阅顺序串行调用；若监听器返回 Promise 则等待其 resolve。
   */
  emit(eventName: string, payload?: unknown): Promise<void>

  /** 移除事件定义（供测试/卸载模块用）。 */
  undefine(eventName: string): void

  /** 当前已定义的事件名列表（供调试/检视）。 */
  definedEvents(): string[]
}
