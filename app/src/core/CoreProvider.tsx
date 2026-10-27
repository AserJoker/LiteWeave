/**
 * CoreProvider —— 把应用级 core 单例注入 React 组件树。
 *
 * App 启动时异步创建 core（含 settings 模块注册 + 全量加载），
 * 完成后通过 CoreContext 提供给任意组件。
 * 组件用 useCore()（见 coreContext.ts）取 core。
 */
import type { ReactNode } from 'react'
import type { AppCore } from './appCore.js'
import { CoreContext } from './coreContext.js'

interface CoreProviderProps {
  core: AppCore | null
  children: ReactNode
}

export function CoreProvider({ core, children }: CoreProviderProps) {
  return <CoreContext.Provider value={core}>{children}</CoreContext.Provider>
}
