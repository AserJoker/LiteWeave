/**
 * IDE 工作区布局类型 —— 面板容器（左/右侧边栏）的状态模型。
 *
 * 设计（为未来拖拽重排打基础）：
 * - 每个容器（left/right）承载一组面板（panels 数组），面板归属 = 所在容器的 panels
 * - 拖拽重排未来 = 把面板 id 从一个容器的 panels 移到另一个容器的 panels
 * - activePanel 记录容器当前激活的面板；visible/size 记录开关与宽度（拖拽结果）
 * - 整个布局对象原子持久化到 layout 数据域（~/.liteweave/layout.json）
 */

/** 面板 id（未来扩展新面板只需在此追加） */
export type PanelId = 'explorer' | 'inspector' | 'history'

/** 合法面板 id（运行时白名单，用于过滤持久化旧数据中的失效面板，如已移除的 ai） */
export const PANEL_IDS: readonly PanelId[] = ['explorer', 'inspector', 'history']

/** 单个面板容器（侧边栏）的状态 */
export interface PanelContainerState {
  /** 容器是否可见 */
  visible: boolean
  /** 容器宽度（px，拖拽结果） */
  size: number
  /** 当前激活的面板 id */
  activePanel: PanelId
  /** 该容器承载的面板 id 列表（归属；拖拽重排 = 移动面板到别的容器） */
  panels: PanelId[]
}

/** 工作区布局快照（整体读写） */
export interface LayoutState {
  left: PanelContainerState
  right: PanelContainerState
}

/** 默认布局：左侧资源管理器，右侧检视器 */
export const DEFAULT_LAYOUT: LayoutState = {
  left: { visible: true, size: 260, activePanel: 'explorer', panels: ['explorer'] },
  right: { visible: true, size: 300, activePanel: 'inspector', panels: ['inspector'] },
}

/** 布局 store 的根 key（整体原子读写） */
export const LAYOUT_STORE_KEY = 'layout'

/** 深度合并默认布局：缺失字段（旧版本数据）回退默认值，保证结构完整 */
export function normalizeLayout(raw: unknown): LayoutState {
  const data = (raw ?? {}) as Partial<LayoutState>
  const left = { ...DEFAULT_LAYOUT.left, ...(data.left ?? {}) }
  const right = { ...DEFAULT_LAYOUT.right, ...(data.right ?? {}) }
  const normalizeContainer = (c: PanelContainerState, fallbackPanels: PanelId[]): PanelContainerState => {
    // 过滤持久化旧数据中已失效的面板 id（如已移除的 ai），空列表回退默认归属
    const panels = Array.isArray(c.panels) ? (c.panels as PanelId[]).filter((p) => PANEL_IDS.includes(p)) : []
    return {
      ...c,
      panels: panels.length > 0 ? panels : fallbackPanels,
    }
  }
  return {
    left: normalizeContainer(left, DEFAULT_LAYOUT.left.panels),
    right: normalizeContainer(right, DEFAULT_LAYOUT.right.panels),
  }
}
