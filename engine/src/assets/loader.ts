/**
 * AssetLoader —— id → 描述对象的加载与缓存。
 *
 * 职责：
 * - 解析资源 id（<namespace>:<path>）→ 相对项目根路径（assets/<ns>/<path>）
 * - 按 type 分派给注册的 AssetTypeLoader
 * - 缓存已加载描述对象（按 id，引用稳定满足 Renderer 缓存契约）
 * - 支持递归加载依赖（pipeline-graph 引用 model/material/pipeline，通过 ctx.loadAsset）
 *
 * 与 Renderer 缓存的关系（见 memory: experience_architecture_gpu-cache-lifecycle）：
 * - AssetLoader 持描述对象缓存（id → Model/Material/Pipeline/PipelineGraph 实例）
 * - Renderer 持 GPU 资源缓存（id → GPU buffer/texture/pipeline）
 * - 两层独立：loadAsset 返回的描述对象引用稳定 → Renderer 引用相等判断同一 GPU 资源
 * - 场景切换时 AssetLoader 预加载新 graph 引用的资产，Renderer 做 set diff 保留/释放
 *
 * type 推断优先级：
 * 1. 若提供 manifest（project.json resources 清单），按 id 查 type
 * 2. 否则按文件后缀反查注册表（.obj → model、.mat.json → material）
 */
import type {
  AssetId,
  AssetLoadContext,
  AssetManifest,
  AssetType,
  AssetTypeRegistry,
  FileSystemAdapter,
  ParsedAssetId,
} from './types.js'

/** AssetLoader 配置 */
export interface AssetLoaderOptions {
  /** 项目根目录（相对路径基准，仅用于 ctx 透传，实际读文件由 fs 适配器处理） */
  projectRoot: string
  /** 项目命名空间列表 */
  namespaces: string[]
  /** 默认命名空间 */
  defaultNamespace: string
  /** 文件系统适配器（fs 依赖注入） */
  fs: FileSystemAdapter
  /** 资源类型注册表 */
  registry: AssetTypeRegistry
  /** 资源清单（可选，来自 project.json resources；提供则按 id 查 type） */
  manifest?: AssetManifest
}

export class AssetLoader {
  private readonly opts: AssetLoaderOptions
  /** 描述对象缓存：id → 描述对象（引用稳定） */
  private readonly cache = new Map<AssetId, unknown>()
  /** 进行中的加载（防并发重复加载同一 id） */
  private readonly pending = new Map<AssetId, Promise<unknown>>()
  /** manifest 索引：id → type（若有） */
  private readonly manifestIndex: Map<AssetId, AssetType> | null

  constructor(opts: AssetLoaderOptions) {
    this.opts = opts
    this.manifestIndex = opts.manifest
      ? new Map(opts.manifest.map((e) => [e.id, e.type]))
      : null
  }

  /**
   * 加载资源（带缓存）。
   * 同一 id 多次调用返回同一 Promise（防并发），resolve 后返回同一描述对象实例（引用稳定）。
   */
  async loadAsset<T = unknown>(id: AssetId): Promise<T> {
    // 命中缓存直接返回
    const cached = this.cache.get(id)
    if (cached !== undefined) return cached as T

    // 进行中则复用 Promise（防并发重复加载）
    const pending = this.pending.get(id)
    if (pending) return pending as Promise<T>

    const p = this.doLoad(id).then((result) => {
      this.cache.set(id, result)
      this.pending.delete(id)
      return result
    }).catch((err) => {
      this.pending.delete(id)
      throw err
    })
    this.pending.set(id, p)
    return p as Promise<T>
  }

  /** 是否已加载（缓存命中） */
  has(id: AssetId): boolean {
    return this.cache.has(id)
  }

  /** 从缓存移除（不主动释放 GPU 资源，由 Renderer 场景切换 diff 处理） */
  evict(id: AssetId): void {
    this.cache.delete(id)
  }

  /** 清空缓存 */
  clear(): void {
    this.cache.clear()
  }

  /** 解析资源 id → { namespace, path } */
  parseId(id: AssetId): ParsedAssetId {
    const colonIdx = id.indexOf(':')
    if (colonIdx < 0) {
      // 无冒号：默认命名空间 + 全串为 path
      return { namespace: this.opts.defaultNamespace, path: id }
    }
    return {
      namespace: id.slice(0, colonIdx),
      path: id.slice(colonIdx + 1),
    }
  }

  /** 解析资源 id → 相对项目根路径（assets/<namespace>/<path>） */
  resolvePath(id: AssetId): string {
    const { namespace, path } = this.parseId(id)
    return `assets/${namespace}/${path}`
  }

  /** 实际加载逻辑：解析 id → 推断 type → 分派 loader */
  private async doLoad(id: AssetId): Promise<unknown> {
    const parsedId = this.parseId(id)
    const type = this.resolveType(id, parsedId.path)
    const loader = this.opts.registry.get(type)
    if (!loader) {
      throw new Error(`[asset] 未注册资源类型 "${type}"（id: ${id}）；请先 register 对应 loader`)
    }

    const ctx: AssetLoadContext = {
      projectRoot: this.opts.projectRoot,
      namespaces: this.opts.namespaces,
      defaultNamespace: this.opts.defaultNamespace,
      fs: this.opts.fs,
      loadAsset: (depId) => this.loadAsset(depId),
    }

    return loader.load(id, parsedId, ctx)
  }

  /**
   * 推断资源 type：
   * 1. manifest 有则按 id 查
   * 2. 否则按文件后缀反查注册表
   * 3. 都失败则报错
   */
  private resolveType(id: AssetId, path: string): AssetType {
    // 1. manifest 查
    if (this.manifestIndex) {
      const t = this.manifestIndex.get(id)
      if (t) return t
    }

    // 2. 后缀反查（支持复合后缀如 .mat.json、.pipeline.json）
    const ext = extractExtension(path)
    const loader = this.opts.registry.getByExtension(ext)
    if (loader) return loader.type

    throw new Error(`[asset] 无法推断资源 type（id: ${id}, path: ${path}）；manifest 未声明且后缀 "${ext}" 未注册 loader`)
  }
}

/**
 * 提取文件后缀（支持复合后缀如 .mat.json、.pipeline.json、.graph.json）。
 * 规则：取最后两段若为 ".<x>.json" 则返回完整两段，否则只取最后一段。
 * 例：cube.obj → .obj；cube.mat.json → .mat.json；cube.wgsl → .wgsl
 */
export function extractExtension(path: string): string {
  const slashIdx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const filename = slashIdx >= 0 ? path.slice(slashIdx + 1) : path
  const dotIdx = filename.lastIndexOf('.')
  if (dotIdx < 0) return ''
  const last = filename.slice(dotIdx).toLowerCase()
  // 检查倒数第二段
  const beforeLast = filename.slice(0, dotIdx)
  const secondDotIdx = beforeLast.lastIndexOf('.')
  if (secondDotIdx >= 0) {
    const second = beforeLast.slice(secondDotIdx).toLowerCase()
    // 复合后缀：<x>.json 形式（如 .mat.json、.pipeline.json、.graph.json）
    if (last === '.json' && second.length > 0) {
      return second + last
    }
  }
  return last
}
