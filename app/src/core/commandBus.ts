/**
 * CommandBus —— 命令驱动上层（雏形）。
 *
 * 架构约定：命令（Command）是事件的上层封装 / 一种事件类型。
 * - 命令事件名统一使用 `command:` 命名空间前缀
 * - 人工操作与 AI 指令都通过 `runCommand` 走同一条指令通道（统一入口）
 * - 命令本身通过底层 EventBus 分发，监听者即命令的处理者（handler）
 *
 * 当前为雏形：只提供统一入口 + 事件分发，不含撤销/重做与脏标记。
 * 后续扩展点（为撤销重做预留）：
 *   - 命令定义可携带 execute / undo / redo 描述，CommandBus 记录执行历史
 *   - 执行前后发出 command:before / command:after 生命周期事件
 */
import type { IEventBus } from './types.js'

/** 命令事件名的命名空间前缀 */
export const COMMAND_PREFIX = 'command:'

/** 把命令名规范为事件名：`submit` -> `command:submit` */
export function commandEventName(command: string): string {
  return command.startsWith(COMMAND_PREFIX) ? command : `${COMMAND_PREFIX}${command}`
}

/**
 * 命令执行入口：人工操作 / AI 指令统一通过它发出命令。
 * 返回命令执行是否成功（任一监听器抛错即视为失败，但不中断其它监听器 —— 由 EventBus 隔离）。
 */
export function createCommandBus(bus: IEventBus) {
  const commandBus = {
    /**
     * 运行一条命令。
     * - command：命令名（如 "submit"、"openResource"），自动加 `command:` 前缀
     * - args：命令参数，作为事件载荷
     * 命令通过底层事件总线分发到订阅者（handler）。
     */
    async runCommand(command: string, args?: unknown): Promise<void> {
      const eventName = commandEventName(command)
      // 命令作为事件发布；未注册的命令由 EventBus 提示（宽松允许）
      await bus.emit(eventName, args)
    },

    /**
     * 订阅一条命令（注册命令 handler）。
     * 返回取消订阅函数。
     */
    onCommand(command: string, handler: (args: unknown) => void | Promise<void>): () => void {
      return bus.subscribe(commandEventName(command), handler)
    },
  }
  return commandBus
}

/** 命令总线的结构类型（便于模块依赖注入时声明） */
export interface CommandBus {
  runCommand(command: string, args?: unknown): Promise<void>
  onCommand(command: string, handler: (args: unknown) => void | Promise<void>): () => void
}
