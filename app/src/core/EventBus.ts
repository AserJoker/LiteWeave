/**
 * EventBus —— 事件总线实现。
 *
 * 以事件总线为核心的底层通信机制：
 * - 模块通过 `define` 声明事件契约（含可选 schema 运行时校验）
 * - 模块通过 `subscribe` 订阅、`emit` 发布，模块间不直接引用
 * - 错误隔离：单个监听器抛错不影响其它监听器
 * - 校验失败：emit 时若载荷不符合事件定义的 schema，抛出明确错误（不触发监听器）
 */
import type { EventDefinition, EventListener, IEventBus, Unsubscribe } from './types.js'

interface RegisteredEvent {
  schema?: EventDefinition['schema']
  description?: string
}

export class EventBus implements IEventBus {
  private readonly events = new Map<string, RegisteredEvent>()
  private readonly listeners = new Map<string, Set<EventListener>>()

  define(event: EventDefinition): void {
    const existing = this.events.get(event.name)
    if (existing) {
      // 重复注册：后注册覆盖前一个，提示以便排查模块间命名冲突
      console.warn(`[eventbus] 事件 "${event.name}" 重复定义，schema 将被覆盖`)
    }
    this.events.set(event.name, {
      schema: event.schema,
      description: event.description,
    })
  }

  undefine(eventName: string): void {
    this.events.delete(eventName)
    this.listeners.delete(eventName)
  }

  definedEvents(): string[] {
    return Array.from(this.events.keys())
  }

  subscribe(eventName: string, listener: EventListener): Unsubscribe {
    let set = this.listeners.get(eventName)
    if (!set) {
      set = new Set()
      this.listeners.set(eventName, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) {
        this.listeners.delete(eventName)
      }
    }
  }

  async emit(eventName: string, payload?: unknown): Promise<void> {
    const registered = this.events.get(eventName)

    // 未定义的事件：允许发布（宽松），但提示，便于发现拼写错误/未注册事件
    if (!registered) {
      console.warn(`[eventbus] 发布未定义事件 "${eventName}"（如需校验载荷，请先用 define 注册）`)
    } else if (registered.schema) {
      const error = registered.schema(payload)
      if (error) {
        throw new Error(`[eventbus] 事件 "${eventName}" 载荷校验失败: ${error}`)
      }
    }

    const set = this.listeners.get(eventName)
    if (!set || set.size === 0) return

    // 串行调用，避免并发下的顺序不确定性；单监听器异常不影响其它监听器
    for (const listener of Array.from(set)) {
      try {
        await listener(payload)
      } catch (err) {
        console.error(`[eventbus] 事件 "${eventName}" 的监听器执行出错:`, err)
      }
    }
  }
}
