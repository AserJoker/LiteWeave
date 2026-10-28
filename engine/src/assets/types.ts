/**
 * Asset 模块类型定义 —— 资源加载层的接口契约。
 *
 * 设计（见 docs/design/resource-protocol.md + memory: experience_architecture_gpu-cache-lifecycle）：
 * - Asset 模块在 engine 层，负责 id → 描述对象的加载与缓存
 * - fs 依赖通过 FileSystemAdapter 抽象注入（engine 保持纯逻辑，不直接 import fs）
 * - 描述对象缓存按 id（引用稳定，满足 Renderer 缓存契约"同一资产描述对象引用相等"）
 * - 与 Renderer 缓存分层：AssetLoader 持描述对象缓存，Renderer 持 GPU 资源缓存
 *
 * 资源 id 格式（与 project.json v2 协议一致）：<namespace>:<path>
 *   例：demogame:models/cube.obj、demogame:materials/cube-vertex-color.mat.json
 *   解析：按第一个 ':' 切分，namespace = 顶层目录名，path = 相对该命名空间目录
 *
 * 资源 type（引擎资源类别，决定加载器分派）：
 *   model | material | pipeline | pipeline-graph | shader | scene | texture | i18n ...
 *   type 由文件后缀推断（.obj → model、.mat.json → material、.pipeline.json → pipeline、
 *   .graph.json → pipeline-graph、.wgsl → shader），或 project.json resources 清单显式声明。
 */

/** 资源 id：<namespace>:<path>（与 project.json v2 协议一致） */
export type AssetId = string

/** 引擎资源类别（决定加载器分派） */
export type AssetType =
  | 'model'
  | 'material'
  | 'pipeline'
  | 'pipeline-graph'
  | 'shader'
  | 'scene'
  | 'texture'
  | 'i18n'
  // 扩展点：插件可注册自定义 type
  | (string & {})

/** 已解析的资源 id（namespace + path） */
export interface ParsedAssetId {
  namespace: string
  path: string
}

/**
 * 文件系统适配器 —— engine 通过此接口读文件，不直接 import fs。
 *
 * 实现侧（app/runner）注入：
 * - Web/Electron Runner：IPC 调主进程读项目目录文件
 * - 未来 native 后端：直接 fs.readFileSync 或 mmap
 * - 测试：内存 mock
 *
 * 所有路径均为相对项目根的 POSIX 风格（/ 分隔），实现负责转为平台绝对路径。
 */
export interface FileSystemAdapter {
  /**
   * 读文本文件（UTF-8）。
   * @param relativePath 相对项目根的路径（如 "assets/demogame/models/cube.obj"）
   * @returns 文件文本内容
   * @throws 文件不存在/读盘错误
   */
  readText(relativePath: string): Promise<string>

  /**
   * 读二进制文件（ArrayBuffer）。
   * 用于 .obj 顶点数据（若走二进制路径）、.bin 几何数据、纹理等。
   * @param relativePath 相对项目根的路径
   * @returns 二进制内容
   */
  readBinary?(relativePath: string): Promise<ArrayBuffer>

  /** 列目录（用于扫描/校验，可选） */
  listDir?(relativePath: string): Promise<DirEntry[]>
}

/** 目录条目 */
export interface DirEntry {
  name: string
  /** 'file' | 'dir' */
  kind: 'file' | 'dir'
  /** 文件字节数（kind='file' 时） */
  size?: number
}

/**
 * 资源加载上下文 —— 传给 AssetType loader 的运行时环境。
 *
 * loader 可通过 ctx.loadAsset 递归加载依赖（如 pipeline-graph 引用 model/material/pipeline）。
 * 递归由 AssetLoader 内部缓存兜底（循环依赖检测待后续）。
 */
export interface AssetLoadContext {
  /** 项目根目录（相对路径基准） */
  projectRoot: string
  /** 项目命名空间列表（来自 project.json namespaces） */
  namespaces: string[]
  /** 默认命名空间 */
  defaultNamespace: string
  /** 文件系统适配器 */
  fs: FileSystemAdapter
  /** 递归加载依赖资源（带缓存） */
  loadAsset<T = unknown>(id: AssetId): Promise<T>
}

/**
 * 资源类型加载器 —— 按资源 type 注册，负责把磁盘文件解析为 engine 描述对象。
 *
 * 注册到 AssetTypeRegistry，AssetLoader 按 type 分派。
 * loader 必须返回 engine 已定义的描述对象类型（Model/Material/Pipeline/PipelineGraph 等）。
 */
export interface AssetTypeLoader<T = unknown> {
  /** 资源 type（如 'model'、'material'） */
  type: AssetType
  /** 匹配的文件后缀（如 ['.obj']、['.mat.json']；含点的完整后缀） */
  extensions: readonly string[]
  /**
   * 加载并解析资源。
   * @param id 资源 id（<namespace>:<path>）
   * @param parsedId 已解析的 namespace + path
   * @param ctx 加载上下文（含 fs + 递归 loadAsset）
   * @returns engine 描述对象（Model/Material/Pipeline/PipelineGraph 等）
   */
  load(id: AssetId, parsedId: ParsedAssetId, ctx: AssetLoadContext): Promise<T>
}

/**
 * 资源类型注册表 —— AssetLoader 按 type 查 loader，按文件后缀反查 type。
 *
 * 插件可注册新 type（如自定义 .particle.json → 'particle' type）；
 * 系统内置 type（model/material/pipeline/pipeline-graph/shader）在 engine 启动时注册。
 */
export interface AssetTypeRegistry {
  /** 注册一个资源类型 loader；type 重复报错 */
  register(loader: AssetTypeLoader): void
  /** 按 type 取 loader */
  get(type: AssetType): AssetTypeLoader | undefined
  /** 按文件后缀反查 type（取第一个命中） */
  getByExtension(ext: string): AssetTypeLoader | undefined
  /** 全部已注册 */
  list(): AssetTypeLoader[]
  /** 移除 */
  unregister(type: AssetType): void
}

/**
 * 资源清单条目（与 project.json resources 一致，见 resource-protocol.md §3.3）。
 *
 * 约定：id 本身就是资源在包内的位置（<namespace>:<path>，path 含扩展名），
 * 因此清单只声明 id → type 关系，不再单独存 path。
 *
 * AssetLoader 用 manifest 按 id 查 type（优先），无声明时退化为按文件后缀反查。
 */
export interface AssetManifestEntry {
  id: AssetId
  type: AssetType
}

/** project.json resources 清单（AssetLoader 可选接收） */
export type AssetManifest = AssetManifestEntry[]
