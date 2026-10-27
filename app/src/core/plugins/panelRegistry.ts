/**
 * 侧边栏面板注册器 —— 面板 id → 标题/图标/渲染组件/归属侧。
 *
 * 设计（见 docs/design/plugin-system.md §4.3）：
 * - Left/RightSidebar 原用静态 tab 列表 + 硬编码渲染；改为按注册表过滤 side 渲染。
 * - 面板 id 与 layout 的 activePanel（PanelId）对齐。
 */
import type { ComponentType } from 'react'

/** 面板归属侧边栏 */
export type PanelSide = 'left' | 'right'

/** 侧边栏面板定义 */
export interface PanelDefinition {
  /** 面板 id（如 explorer / inspector；与 layout 的 activePanel 对应） */
  id: string
  /** 面板标题 i18n key */
  titleKey: string
  /** Blueprint icon 名 */
  icon: string
  /** 面板渲染组件 */
  component: ComponentType
  /** 归属侧边栏：'left' | 'right'（默认 left） */
  side?: PanelSide
}

/** 面板注册器接口（挂 PluginContext.panels，插件 init 时注册） */
export interface PanelRegistry {
  /** 注册面板；id 为空 / 重复报错 */
  register(def: PanelDefinition): void
  /** 按 id 取 */
  get(id: string): PanelDefinition | undefined
  /** 全部已注册（可按 side 过滤） */
  list(side?: PanelSide): PanelDefinition[]
  /** 移除（供测试/卸载） */
  unregister(id: string): void
}

/** 创建面板注册器（core 内置；由 createCore 实例化并挂到 ctx） */
export function createPanelRegistry(): PanelRegistry {
  const defs = new Map<string, PanelDefinition>()

  return {
    register(def: PanelDefinition): void {
      if (!def || typeof def.id !== 'string' || !def.id) {
        throw new Error('[panel] 面板定义缺少有效 id')
      }
      if (defs.has(def.id)) {
        throw new Error(`[panel] 面板 "${def.id}" 已注册，不能重复注册`)
      }
      defs.set(def.id, def)
    },

    get(id: string): PanelDefinition | undefined {
      return defs.get(id)
    },

    list(side?: PanelSide): PanelDefinition[] {
      const all = Array.from(defs.values())
      return side ? all.filter((d) => (d.side ?? 'left') === side) : all
    },

    unregister(id: string): void {
      defs.delete(id)
    },
  }
}
