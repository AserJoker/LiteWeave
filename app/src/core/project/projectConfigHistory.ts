/**
 * project-config 历史内容模块 —— project.json 配置编辑器的历史权威（模块级）。
 *
 * 设计（用户定案：历史权威在编辑器，框架只是展示/操作镜像）：
 * - 本模块即"编辑器侧历史权威"：持有每个 path 的完整历史栈（内容快照 + 指针 currentIndex）
 *   + 初始基线（undo 到 -1 时还原）。会话级，不随组件卸载丢失。
 * - 框架（historyModule）只维护展示镜像（label/id/timestamp + 指针镜像），
 *   本模块每次权威变更后调 history.syncStack(path, items, currentIndex) 同步回框架。
 * - 撤销/重做/回退：框架只发命令（不移动指针），本模块监听命令 → 自己移动指针 →
 *   找目标快照（-1 用基线）→ SET_PROJECT_CONFIG_COMMAND 写盘还原 → syncStack 同步回。
 * - push 语义（回到某个历史点后再编辑）：以当前指针为地基截断其后的 redo 分支，
 *   追加新历史项，指针移到末尾 —— "从回到的点开始重新生长历史"。
 *
 * 数据流：
 * - 编辑器写盘确认后（PROJECT_CONFIG_CHANGED 回推）调 recordSnapshot(path, label) →
 *   截断 redo 分支 + 追加快照 + 指针移末尾 + syncStack。
 * - 组件加载配置时（无待命历史）调 recordBaseline(path) 记录初始扁平值。
 */
import type { CommandBus } from '../commandBus.js'
import type { FormValues } from '../schema/schemaForm.js'
import { projectMetaToForm, projectFormToPatch } from '../schema/schemaProjectConfig.js'
import { SET_PROJECT_CONFIG_COMMAND } from './projectModule.js'
import {
  HISTORY_UNDO_COMMAND,
  HISTORY_REDO_COMMAND,
  HISTORY_SEEK_COMMAND,
  type HistoryApi,
  type HistoryCommandArgs,
  type HistoryItem,
} from '../history/historyModule.js'

/** 快照：编辑器侧权威历史项（完整内容 + 展示元数据） */
export interface EditorSnapshot {
  /** 与框架 HistoryItem.id 对应（seek 定位用） */
  id: string
  /** 展示名称（同步给框架渲染） */
  label: string
  /** 产生时间 ISO */
  timestamp: string
  /** 写盘后的全量扁平表单值（undo/redo/seek 还原用） */
  flat: FormValues
}

/** 编辑器侧权威栈：快照列表 + 指针（当前状态位置；-1 = 无历史/初始状态） */
interface EditorStack {
  items: EditorSnapshot[]
  currentIndex: number
}

/** 模块级权威历史栈：按 path 存储（会话级持久，关闭进程消失；组件重挂载恢复） */
const stacks = new Map<string, EditorStack>()
/** 模块级初始基线缓存：按 path 存储编辑器首次加载配置时的全量扁平值（undo 到 currentIndex=-1 时还原） */
const baselineCache = new Map<string, FormValues>()

/** 历史项 id 自增种子（会话内唯一） */
let idSeed = 0
function nextItemId(): string {
  idSeed += 1
  return `h${idSeed}`
}

/** 取或建某文件权威栈 */
function ensureStack(path: string): EditorStack {
  let stack = stacks.get(path)
  if (!stack) {
    stack = { items: [], currentIndex: -1 }
    stacks.set(path, stack)
  }
  return stack
}

/** 把编辑器侧权威栈同步成框架展示镜像（items 元数据 + 指针） */
function syncToFramework(history: HistoryApi | undefined, path: string, stack: EditorStack): void {
  const items: HistoryItem[] = stack.items.map((s) => ({ id: s.id, label: s.label, timestamp: s.timestamp }))
  history?.syncStack(path, items, stack.currentIndex)
}

/**
 * 读取某文件权威快照栈（组件挂载时初始化展示用）
 */
export function getSnapshots(path: string): EditorSnapshot[] {
  return stacks.get(path)?.items ?? []
}

/** 读取某文件当前指针（-1 = 无历史/初始状态；组件挂载时初始化展示用） */
export function getCurrentIndex(path: string): number {
  return stacks.get(path)?.currentIndex ?? -1
}

/** 记录初始基线（编辑器首次加载配置时调用；已存在则不覆盖） */
export function recordBaseline(path: string, flat: FormValues): void {
  if (!baselineCache.has(path)) {
    baselineCache.set(path, flat)
  }
}

/** 读取初始基线（undo 到 -1 还原用） */
export function getBaseline(path: string): FormValues | undefined {
  return baselineCache.get(path)
}

/**
 * 编辑器写盘确认后调用：产生一条历史项。
 * 以当前指针为地基截断其后的 redo 分支，追加新项，指针移到末尾；随后同步回框架。
 */
export function pushSnapshot(
  path: string,
  entry: { label: string; flat: FormValues },
  history?: HistoryApi,
): void {
  const stack = ensureStack(path)
  const snapshot: EditorSnapshot = {
    id: nextItemId(),
    label: entry.label,
    timestamp: new Date().toISOString(),
    flat: entry.flat,
  }
  // 截断 currentIndex 之后的 redo 分支，追加新项，指针移到末尾（从回到的点重新生长历史）
  stack.items = stack.items.slice(0, stack.currentIndex + 1)
  stack.items.push(snapshot)
  stack.currentIndex = stack.items.length - 1
  stacks.set(path, stack)
  syncToFramework(history, path, stack)
}

/**
 * 模块级注册历史命令监听（core 就绪后调用一次）：
 * undo / redo / seek → 编辑器自己移动指针 → 找目标快照（-1 用基线）→ 写盘还原 → 同步回框架。
 * 不依赖编辑器组件挂载：命令发出时即使编辑器未挂载也能执行还原。
 */
export function registerProjectConfigHistory(
  commands: CommandBus,
  history: HistoryApi,
  onError?: (err: unknown) => void,
): () => void {
  /** 把某文件状态还原到指定历史项（编辑器权威操作：移动指针 + 写盘 + 同步框架） */
  const applyHistory = (path: string, itemId?: string) => {
    const stack = stacks.get(path)
    if (!stack) return
    // 目标 id：显式（seek）或当前指针指向的项（undo/redo 已由编辑器前移/后移指针）
    const targetId = itemId ?? stack.items[stack.currentIndex]?.id
    // 无目标 id（指针回到 -1，即初始状态）：还原到编辑器首次加载的基线扁平值
    const flat = targetId
      ? stack.items.find((s) => s.id === targetId)?.flat
      : baselineCache.get(path)
    if (!flat) return
    // 全量扁平值 → 嵌套 patch 写盘（回推后 UI 刷新）；指针/镜像已在命令处理时更新
    const patch = projectFormToPatch(flat)
    void commands.runCommand(SET_PROJECT_CONFIG_COMMAND, { patch }).catch((err) => {
      console.error('[project-config] 历史还原失败:', err)
      onError?.(err)
    })
  }

  /** 解析目标路径：显式 path 优先，缺省用当前活动编辑器路径（AI/MCP 调用无需知道 path） */
  const resolvePath = (args: HistoryCommandArgs): string | undefined => {
    const { path } = args
    return path || history.getActivePath()
  }

  const unsubUndo = commands.onCommand(HISTORY_UNDO_COMMAND, (args) => {
    const path = resolvePath((args ?? {}) as HistoryCommandArgs)
    if (!path) return
    const stack = stacks.get(path)
    if (!stack || stack.currentIndex < 0) return
    // 编辑器权威：自己移动指针（框架不移动）
    stack.currentIndex -= 1
    stacks.set(path, stack)
    syncToFramework(history, path, stack)
    applyHistory(path)
  })
  const unsubRedo = commands.onCommand(HISTORY_REDO_COMMAND, (args) => {
    const path = resolvePath((args ?? {}) as HistoryCommandArgs)
    if (!path) return
    const stack = stacks.get(path)
    if (!stack || stack.currentIndex >= stack.items.length - 1) return
    // 编辑器权威：自己移动指针（框架不移动）
    stack.currentIndex += 1
    stacks.set(path, stack)
    syncToFramework(history, path, stack)
    applyHistory(path)
  })
  const unsubSeek = commands.onCommand(HISTORY_SEEK_COMMAND, (args) => {
    const { itemId } = (args ?? {}) as HistoryCommandArgs
    const path = resolvePath((args ?? {}) as HistoryCommandArgs)
    if (!path || !itemId) return
    const stack = stacks.get(path)
    if (!stack) return
    const idx = stack.items.findIndex((s) => s.id === itemId)
    if (idx < 0) return
    // 编辑器权威：自己移动指针（框架不移动）
    stack.currentIndex = idx
    stacks.set(path, stack)
    syncToFramework(history, path, stack)
    applyHistory(path, itemId)
  })

  return () => {
    unsubUndo()
    unsubRedo()
    unsubSeek()
  }
}

/** 辅助：配置对象 → 扁平表单值（供 recordBaseline / pushSnapshot 复用） */
export function configToForm(config: Record<string, unknown>): FormValues {
  return projectMetaToForm(config)
}
