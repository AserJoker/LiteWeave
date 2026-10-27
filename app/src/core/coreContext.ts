/**
 * Core Context —— 应用级 core 单例的 React Context。
 *
 * 与 CoreProvider 分离：Context 对象 + hook 放在独立文件，避免
 * Fast Refresh 对“组件 + 非组件导出”同文件的限制。
 */
import { createContext, useContext } from 'react'
import type { AppCore } from './appCore.js'

export const CoreContext = createContext<AppCore | null>(null)

/** 组件树内取 core；未挂载（初始化中）返回 null */
export function useCore(): AppCore | null {
  return useContext(CoreContext)
}
