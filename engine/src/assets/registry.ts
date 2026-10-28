/**
 * AssetTypeRegistry 实现 —— 资源类型注册表。
 *
 * 按 type 索引 loader（加载时按 type 分派）；按 extension 反查 loader（无清单时凭后缀推断 type）。
 * 注册顺序决定 extension 反查优先级（后注册的先命中，允许插件覆盖内置）。
 */
import type { AssetType, AssetTypeLoader, AssetTypeRegistry } from './types.js'

export function createAssetTypeRegistry(): AssetTypeRegistry {
  /** type → loader（按 type 直查） */
  const byType = new Map<AssetType, AssetTypeLoader>()
  /** extension → loader（按后缀反查；同后缀多次注册以最后注册为准，允许插件覆盖） */
  const byExt = new Map<string, AssetTypeLoader>()

  return {
    register(loader) {
      if (!loader || typeof loader.type !== 'string' || !loader.type) {
        throw new Error('[asset] 资源类型 loader 缺少有效 type')
      }
      if (byType.has(loader.type)) {
        throw new Error(`[asset] 资源类型 "${loader.type}" 已注册，不能重复注册`)
      }
      byType.set(loader.type, loader)
      for (const ext of loader.extensions) {
        byExt.set(ext, loader)
      }
    },

    get(type) {
      return byType.get(type)
    },

    getByExtension(ext) {
      // 标准化：确保以 '.' 开头，小写
      const e = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
      return byExt.get(e)
    },

    list() {
      return [...byType.values()]
    },

    unregister(type) {
      const loader = byType.get(type)
      if (!loader) return
      byType.delete(type)
      for (const ext of loader.extensions) {
        const cur = byExt.get(ext)
        if (cur === loader) byExt.delete(ext)
      }
    },
  }
}
