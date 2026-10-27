/**
 * PluginHost —— 插件注册表 + 生命周期调度。
 *
 * 负责插件的生命周期（设计见 docs/design/plugin-system.md §5）：
 * - register(plugin)：只登记插件（重复 id 报错），不做三阶段调度
 * - start()：批量执行三级生命周期 + 宿主就绪动作
 *     1) 全部插件 preInit（配置加载生效 / 插件自身初始化）
 *     2) 全部插件 init（注册资源 + 初始化订阅）
 *     3) 全部插件 postInit（patch 资源 / 与其他插件联动）
 *     4) 宿主就绪动作（由 options.onReady 注入，如聚合回传 MCP 命令清单）
 *   分层批量而非每插件串行三阶段：postInit 语义依赖“所有插件资源已注册完”
 * - 错误处理：某阶段某插件抛错 → 记录并标记该插件失败（不参与后续阶段），其余继续
 * - unregister(id)：调用插件 dispose()（卸载协议，尽力而为）
 */
import type { Plugin, PluginContext } from './module.js'

/** 插件宿主接口 */
export interface PluginHost {
  /** 注册插件：重复 id 报错；只登记，三阶段由 start() 统一调度 */
  register(plugin: Plugin): Promise<void>
  /**
   * 启动：批量执行 preInit→init→postInit，最后触发宿主就绪动作。
   * 某阶段某插件抛错 → 记录并标记失败（不参与后续阶段），其余插件继续。
   */
  start(): Promise<void>
  /** 卸载插件：调用 dispose()（协议，尽力而为） */
  unregister(pluginId: string): Promise<void>
  /** 获取已注册插件 */
  get(pluginId: string): Plugin | undefined
  /** 已注册插件 id 列表 */
  registered(): string[]
  /** 插件启动是否已完成（start() 调用后为 true） */
  started(): boolean
}

export interface CreatePluginHostOptions {
  /** 宿主就绪动作：所有插件三级生命周期完成后调用（如聚合回传 MCP 命令清单） */
  onReady?: (ctx: PluginContext) => void | Promise<void>
}

export function createPluginHost(ctx: PluginContext, options: CreatePluginHostOptions = {}): PluginHost {
  const plugins = new Map<string, Plugin>()
  /** 已启动标志（start() 调用后置 true） */
  let started = false

  /** 执行单个插件的指定阶段钩子；失败标记并返回是否成功 */
  async function runStage(plugin: Plugin, phase: 'preInit' | 'init' | 'postInit'): Promise<boolean> {
    const hook = plugin[phase]
    if (!hook) return true
    try {
      await hook(ctx)
      return true
    } catch (err) {
      console.error(`[plugin] 插件 "${plugin.id}" ${phase} 失败:`, err)
      return false
    }
  }

  /** 批量执行阶段：按注册顺序推进，失败者从后续阶段剔除 */
  async function runPhase(phase: 'preInit' | 'init' | 'postInit'): Promise<void> {
    const failed: string[] = []
    for (const plugin of plugins.values()) {
      if (failed.includes(plugin.id)) continue
      const ok = await runStage(plugin, phase)
      if (!ok) failed.push(plugin.id)
    }
    for (const id of failed) {
      plugins.delete(id)
    }
  }

  return {
    async register(plugin: Plugin): Promise<void> {
      if (plugins.has(plugin.id)) {
        throw new Error(`[plugin] 插件 "${plugin.id}" 已注册，不能重复注册`)
      }
      plugins.set(plugin.id, plugin)
    },

    async start(): Promise<void> {
      if (started) return
      started = true
      // 分层批量：先全部 preInit，再全部 init，最后全部 postInit
      await runPhase('preInit')
      await runPhase('init')
      await runPhase('postInit')
      // 宿主就绪动作（如聚合回传 MCP 命令清单）
      if (options.onReady) {
        try {
          await options.onReady(ctx)
        } catch (err) {
          console.error('[plugin] 宿主就绪动作失败:', err)
        }
      }
    },

    async unregister(pluginId: string): Promise<void> {
      const plugin = plugins.get(pluginId)
      if (!plugin) {
        console.warn(`[plugin] 尝试卸载未注册插件 "${pluginId}"`)
        return
      }
      // 卸载协议：尽力而为，dispose 抛错只记录不中断
      if (plugin.dispose) {
        try {
          await plugin.dispose()
        } catch (err) {
          console.error(`[plugin] 插件 "${pluginId}" dispose 失败（协议，已尽力）:`, err)
        }
      }
      plugins.delete(pluginId)
    },

    get(pluginId: string): Plugin | undefined {
      return plugins.get(pluginId)
    },

    registered(): string[] {
      return Array.from(plugins.keys())
    },

    started(): boolean {
      return started
    },
  }
}

/** 兼容别名：PluginHost 即原 ModuleManager（含 start） */
export type ModuleManager = PluginHost
