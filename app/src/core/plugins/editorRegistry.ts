/**
 * 编辑器注册器 —— 资源类型 id → 编辑器渲染组件。
 *
 * 设计（见 docs/design/plugin-system.md §4.2）：
 * - WorkspaceTabs 原用 switch(tab.type) 硬编码分派编辑器；
 *   改为查本注册器：editors.get(tab.type)?.({ type, tab }) ?? 占位。
 * - 插件注册资源类型 + 编辑器即完成扩展，无需改组件。
 */
import type { ReactNode } from 'react'
import type { EditorTab } from '../../components/types.js'

/** 编辑器渲染属性 */
export interface EditorProps {
  /** 资源类型 id（tab.type） */
  type: string
  /** 编辑器标签（含 path/title/id） */
  tab: EditorTab
}

/** 编辑器渲染组件：输入资源类型 + 标签，输出 React 节点 */
export type EditorComponent = (props: EditorProps) => ReactNode

/** 编辑器注册器接口（挂 PluginContext.editors，插件 init 时注册） */
export interface EditorRegistry {
  /** 注册：资源类型 id → 编辑器渲染组件；type 为空 / 重复报错 */
  register(type: string, component: EditorComponent): void
  /** 按资源类型 id 取渲染组件（未注册返回 undefined → 调用方显示占位） */
  get(type: string): EditorComponent | undefined
  /** 全部已注册资源类型 id */
  list(): string[]
  /** 移除（供测试/卸载） */
  unregister(type: string): void
}

/** 创建编辑器注册器（core 内置；由 createCore 实例化并挂到 ctx） */
export function createEditorRegistry(): EditorRegistry {
  const map = new Map<string, EditorComponent>()

  return {
    register(type: string, component: EditorComponent): void {
      if (!type || typeof component !== 'function') {
        throw new Error('[editor] 编辑器注册缺少有效 type 或组件')
      }
      if (map.has(type)) {
        throw new Error(`[editor] 编辑器 "${type}" 已注册，不能重复注册`)
      }
      map.set(type, component)
    },

    get(type: string): EditorComponent | undefined {
      return map.get(type)
    },

    list(): string[] {
      return Array.from(map.keys())
    },

    unregister(type: string): void {
      map.delete(type)
    },
  }
}
