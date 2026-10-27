/**
 * history 模块 —— 会话级历史（撤销/重做）基础设施。
 *
 * 设计（用户定案）：
 * - 历史表是会话级的：关闭进程即消失，不落盘。
 * - **历史权威在编辑器自身**：编辑器持有完整历史（内容快照/基线/指针），
 *   框架只维护一份展示镜像（label + id + timestamp + 指针位置），供渲染与交互。
 * - 框架不解析内容、不移动指针；指针的移动（undo/redo/seek）由编辑器执行后
 *   通过 syncStack 把最新镜像同步回框架。
 * - 重命名/移动后需要感知并修复：history.renamePath(oldPath, newPath) 迁移栈。
 *
 * 消息通讯（双向）：
 * - 编辑器 → 框架：history.syncStack(path, items, currentIndex) 同步展示镜像（编辑器权威变更后调用）
 * - 框架 → 编辑器：命令通道 system.history:undo / system.history:redo / system.history:seek
 *   （携带 path，编辑器订阅后执行自身撤销/重做/回退逻辑，执行后再 syncStack 同步回）
 * - 框架内部广播 system.history:changed（栈变更 → UI 刷新）
 */
import type { Module, ModuleContext } from '../module.js'
import { systemCommand } from '../namespace.js'
import type { CommandBus } from '../commandBus.js'
import type { IEventBus } from '../types.js'

/* ---------------- 类型 ---------------- */

/** 历史项：框架只感知 id（交互定位）与 label（渲染显示），具体内容由编辑器自身持有 */
export interface HistoryItem {
  /** 历史项 id（会话内唯一，编辑器回退时用它定位自身历史） */
  id: string
  /** 显示名称（如“修改 targetFps”）；框架只用于渲染，不解析含义 */
  label: string
  /** 产生时间 ISO */
  timestamp: string
}

/** 单个文件的展示镜像栈（含指针位置；指针权威在编辑器，此处仅镜像） */
export interface HistoryStack {
  /** 文件在项目中的路径（栈 key） */
  path: string
  /** 全部历史项（按时间顺序）；currentIndex 指向当前状态 */
  items: HistoryItem[]
  /** 当前状态在 items 中的下标；-1 表示无历史（栈空） */
  currentIndex: number
}

/** 历史栈变更载荷（UI 订阅刷新） */
export interface HistoryChangedPayload {
  /** 变更的文件路径 */
  path: string
  /** 最新栈（含指针）；栈被清除时为 undefined */
  stack?: HistoryStack
}

/** 历史命令参数（框架→编辑器） */
export interface HistoryCommandArgs {
  /** 目标文件路径 */
  path: string
  /** seek 专用：回退目标历史项 id */
  itemId?: string
}

/* ---------------- 常量 ---------------- */

/** 事件名：栈变更广播（UI 刷新 / 编辑器感知） */
export const HISTORY_CHANGED = systemCommand('history:changed')
/** 事件名：活动编辑器标签路径变更（history.setActivePath 广播；HistoryPanel 订阅），载荷 { path? } */
export const ACTIVE_PATH_CHANGED = systemCommand('shell:active-path-changed')
/** 命令名：撤销（框架→编辑器） */
export const HISTORY_UNDO_COMMAND = systemCommand('history:undo')
/** 命令名：重做（框架→编辑器） */
export const HISTORY_REDO_COMMAND = systemCommand('history:redo')
/** 命令名：回退到指定历史项（框架→编辑器） */
export const HISTORY_SEEK_COMMAND = systemCommand('history:seek')
/** 命令名：资源重命名/移动后修复历史表（资源管理器/框架调用） */
export const HISTORY_RENAME_COMMAND = systemCommand('history:rename')

/* ---------------- 模块 ---------------- */

/** 历史 api（挂 services['history']，组件/编辑器取用） */
export interface HistoryApi {
  /** 编辑器 → 框架：同步展示镜像（编辑器权威变更后调用；替换整栈+指针） */
  syncStack(path: string, items: HistoryItem[], currentIndex: number): void
  /** 当前文件展示镜像（无历史返回 undefined） */
  getStack(path: string): HistoryStack | undefined
  /** 撤销可用性（镜像指针） */
  canUndo(path: string): boolean
  /** 重做可用性（镜像指针） */
  canRedo(path: string): boolean
  /** 框架 → 编辑器：撤销（只发命令转发，不移动指针）；返回是否发起 */
  undo(path: string): void
  /** 框架 → 编辑器：重做（只发命令转发，不移动指针）；返回是否发起 */
  redo(path: string): void
  /** 框架 → 编辑器：回退到指定历史项（只发命令转发，不移动指针）；返回是否发起 */
  seek(path: string, itemId: string): void
  /** 重命名/移动感知：把旧路径的栈迁移到新路径（栈不存在则忽略） */
  renamePath(oldPath: string, newPath: string): void
  /** 清空某文件历史（如关闭编辑器时）；栈不存在忽略 */
  clear(path: string): void
  /** 设置当前活动编辑器路径（AppShell 标签切换时调用），模块内广播 ACTIVE_PATH_CHANGED */
  setActivePath(path: string | undefined): void
  /** 读取当前活动编辑器路径（面板挂载时初始化用，不依赖广播时机） */
  getActivePath(): string | undefined
  /** 订阅栈变更；返回取消订阅函数 */
  subscribe(listener: (payload: HistoryChangedPayload) => void): () => void
}

/** history 模块实例类型：Module + 公开 api */
export interface HistoryModule extends Module {
  api: HistoryApi
}

/** 扩展模块上下文：挂 history api */
export interface HistoryModuleContext extends ModuleContext {
  history?: HistoryApi
}

export function createHistoryModule(): HistoryModule {
  // 会话级展示镜像表：路径 → 镜像栈（权威在编辑器；关闭进程即消失，不落盘）
  const stacks = new Map<string, HistoryStack>()
  // 当前活动编辑器路径（模块级状态：AppShell 标签切换时 set，面板读 get 初始化；不依赖 UI 挂载时序）
  let activePath: string | undefined
  let events: IEventBus | undefined
  let commands: CommandBus | undefined
  const listeners = new Set<(payload: HistoryChangedPayload) => void>()

  /** 广播栈变更（事件 + 本地监听器） */
  function broadcast(payload: HistoryChangedPayload): void {
    void events?.emit(HISTORY_CHANGED, payload)
    for (const listener of listeners) {
      try {
        listener(payload)
      } catch (err) {
        console.error('[history] 监听器异常:', err)
      }
    }
  }

  const api: HistoryApi = {
    syncStack(path: string, items: HistoryItem[], currentIndex: number): void {
      const stack: HistoryStack = { path, items: [...items], currentIndex }
      stacks.set(path, stack)
      broadcast({ path, stack: { ...stack, items: [...stack.items] } })
    },

    getStack(path: string): HistoryStack | undefined {
      const stack = stacks.get(path)
      if (!stack) return undefined
      return { ...stack, items: [...stack.items] }
    },

    canUndo(path: string): boolean {
      const stack = stacks.get(path)
      return !!stack && stack.currentIndex >= 0
    },

    canRedo(path: string): boolean {
      const stack = stacks.get(path)
      return !!stack && stack.currentIndex < stack.items.length - 1
    },

    undo(path: string): void {
      const stack = stacks.get(path)
      if (!stack || stack.currentIndex < 0) return
      // 框架不移动指针（指针权威在编辑器）：只转发命令，编辑器执行后 syncStack 同步回
      void commands?.runCommand(HISTORY_UNDO_COMMAND, { path } as HistoryCommandArgs)
    },

    redo(path: string): void {
      const stack = stacks.get(path)
      if (!stack || stack.currentIndex >= stack.items.length - 1) return
      // 框架不移动指针（指针权威在编辑器）：只转发命令，编辑器执行后 syncStack 同步回
      void commands?.runCommand(HISTORY_REDO_COMMAND, { path } as HistoryCommandArgs)
    },

    seek(path: string, itemId: string): void {
      const stack = stacks.get(path)
      if (!stack) return
      // 框架不移动指针（指针权威在编辑器）：只转发命令，编辑器执行后 syncStack 同步回
      void commands?.runCommand(HISTORY_SEEK_COMMAND, { path, itemId } as HistoryCommandArgs)
    },

    renamePath(oldPath: string, newPath: string): void {
      if (oldPath === newPath) return
      const stack = stacks.get(oldPath)
      if (!stack) return
      stack.path = newPath
      stacks.delete(oldPath)
      stacks.set(newPath, stack)
      // 广播两条：旧路径栈消失 + 新路径栈出现（UI 用新路径 key 订阅，这里广播新路径即可）
      broadcast({ path: oldPath, stack: undefined })
      broadcast({ path: newPath, stack: { ...stack, items: [...stack.items] } })
    },

    clear(path: string): void {
      if (!stacks.has(path)) return
      stacks.delete(path)
      broadcast({ path, stack: undefined })
    },

    setActivePath(path: string | undefined): void {
      if (activePath === path) return
      activePath = path
      void events?.emit(ACTIVE_PATH_CHANGED, { path })
    },

    getActivePath(): string | undefined {
      return activePath
    },

    subscribe(listener: (payload: HistoryChangedPayload) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  const module: HistoryModule = {
    id: 'history',
    api,

    async init(ctx: ModuleContext): Promise<void> {
      events = ctx.events
      commands = ctx.commands

      // 事件契约（命令走 CommandBus，不在此 define）
      ctx.events.define({ name: HISTORY_CHANGED, description: '历史栈变更广播（编辑器同步镜像），携带 { path, stack? }' })
      ctx.events.define({ name: ACTIVE_PATH_CHANGED, description: '活动编辑器标签路径变更（history.setActivePath 广播），携带 { path? }' })

      // 重命名/移动感知：资源管理器（或其它来源）发 system.history:rename → 迁移栈
      ctx.commands.onCommand(HISTORY_RENAME_COMMAND, (args) => {
        const { oldPath, newPath } = (args ?? {}) as { oldPath?: string; newPath?: string }
        if (oldPath && newPath) {
          api.renamePath(oldPath, newPath)
        }
      })

      // 挂到上下文 + 服务容器
      const historyCtx = ctx as HistoryModuleContext
      historyCtx.history = api
      historyCtx.services['history'] = api
    },
  }

  return module
}
