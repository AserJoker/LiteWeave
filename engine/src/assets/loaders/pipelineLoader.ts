/**
 * Pipeline 资源 loader —— 解析 .pipeline.json 为 engine Pipeline 描述对象。
 *
 * 文件格式（与 Pipeline 接口对齐，见 types.ts Pipeline 注释）：
 * ```json
 * {
 *   "vertexEntryPoint": "vmain",
 *   "fragmentEntryPoint": "fmain",
 *   "shader": "demogame:shaders/cube.wgsl",       // shader 资产 id（递归加载）
 *   "bindings": [
 *     { "binding": 0, "kind": "uniform-buffer", "visibility": "vertex", "bufferSize": 64 }
 *   ],
 *   "uniformBufferLayout": [
 *     { "name": "mvp", "type": "float32x4x4", "offset": 0, "size": 64 }
 *   ],
 *   "topology": "triangle-list",
 *   "cullMode": "back",
 *   "depthState": { "format": "depth24plus", "depthWriteEnabled": true, "depthCompare": "less" },
 *   "colorTargets": [{ "format": "rgba8unorm" }],
 *   "vertexBufferLayouts": [ ...VertexLayout... ]
 * }
 * ```
 *
 * 关键：
 * - shader 用资源 id 引用（不内嵌 WGSL 字符串），loader 通过 ctx.loadAsset<string> 递归加载
 *   多个 pipeline 引用同一 shader 时由 AssetLoader 缓存去重
 * - id 用 loader 入参的 id 覆盖（保证与资源寻址一致）
 * - colorTargets format 可为 "swapchain"（运行时由 runner 替换为实际 preferred format）
 *   → 见 runner 集成时处理（loader 透传字符串，runner 后处理或 pipeline 定义避免 "swapchain" 关键字）
 */
import type { AssetTypeLoader } from '../types.js'
import type {
  Pipeline,
  PipelineBinding,
  UniformFieldSpec,
  PrimitiveTopology,
  CullMode,
  DepthState,
  ColorTargetDesc,
  VertexLayout,
} from '../../types.js'

/** .pipeline.json 文件结构（与 Pipeline 接口对齐，shader 用 id 引用） */
interface PipelineFile {
  vertexEntryPoint: string
  fragmentEntryPoint: string
  /** shader 资产 id（递归加载为 WGSL 源码字符串） */
  shader: string
  bindings: PipelineBinding[]
  uniformBufferLayout?: UniformFieldSpec[]
  topology?: PrimitiveTopology
  cullMode?: CullMode
  depthState?: DepthState
  colorTargets: ColorTargetDesc[]
  vertexBufferLayouts: VertexLayout[]
}

export const pipelineLoader: AssetTypeLoader<Pipeline> = {
  type: 'pipeline',
  extensions: ['.pipeline.json'] as const,
  async load(id, parsedId, ctx) {
    const relativePath = `assets/${parsedId.namespace}/${parsedId.path}`
    const text = await ctx.fs.readText(relativePath)
    let parsed: PipelineFile
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`[pipeline] JSON 解析失败（id: ${id}）: ${(err as Error).message}`)
    }

    // 递归加载 shader 源码
    if (!parsed.shader || typeof parsed.shader !== 'string') {
      throw new Error(`[pipeline] 缺少 shader 资产 id（id: ${id}）`)
    }
    const shaderSource = await ctx.loadAsset<string>(parsed.shader)

    return {
      id,
      shaderSource,
      vertexEntryPoint: parsed.vertexEntryPoint,
      fragmentEntryPoint: parsed.fragmentEntryPoint,
      bindings: parsed.bindings,
      uniformBufferLayout: parsed.uniformBufferLayout ?? [],
      topology: parsed.topology ?? 'triangle-list',
      cullMode: parsed.cullMode ?? 'none',
      depthState: parsed.depthState,
      colorTargets: parsed.colorTargets,
      vertexBufferLayouts: parsed.vertexBufferLayouts,
    }
  },
}
