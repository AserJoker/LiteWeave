/**
 * Model 资源 loader —— 解析自定义 .model.json 为 engine Model 描述对象。
 *
 * 文件格式（顶点属性 SoA 描述 + 交错顶点数据 + 索引）：
 * ```json
 * {
 *   "name": "立方体",
 *   "attributes": [
 *     { "name": "position", "format": "float32x3" },
 *     { "name": "color",    "format": "float32x3" }
 *   ],
 *   "vertices": [
 *     [-0.5, -0.5, -0.5,  1.0, 0.0, 0.0],
 *     ...
 *   ],
 *   "indices": [1, 5, 7,  1, 7, 3, ...]
 * }
 * ```
 *
 * 字段说明：
 * - name：展示名（可选）
 * - attributes：顶点属性声明，按顺序映射到 shader @location(N)（N = 数组下标）
 *   - format：float32x2 | float32x3 | float32x4（与 WebGPU GPUVertexFormat 对齐）
 * - vertices：二维数组，每行一个顶点，按 attributes 顺序交错排列分量
 * - indices：可选；扁平索引数组（0-based），三角形列表；缺省用 draw（非 drawIndexed）
 *
 * 输出 Model：
 * - id = 资源 id（<namespace>:<path>）
 * - vertices: Float32Array（展平后的顶点数据）
 * - indices: Uint16Array | undefined（顶点数 > 65535 报错，暂不支持 Uint32）
 * - vertexLayouts: 单 buffer 布局（arrayStride = 各属性分量数 × 4 之和）
 *
 * 设计权衡：
 * - 不用 OBJ：OBJ 不支持顶点色等任意属性，需自定义格式承载
 * - 不用 glTF：解析器复杂，demo 阶段过重，自定义 JSON 足够
 * - 属性按声明顺序映射 @location(N)：简单直观，shader 与 model.json 对齐即可
 */
import type { AssetTypeLoader } from '../types.js'
import type { Model, VertexAttribute, VertexAttributeFormat, VertexLayout } from '../../types.js'

/** .model.json 文件结构 */
interface ModelFile {
  name?: string
  attributes: Array<{ name: string; format: VertexAttributeFormat }>
  vertices: number[][]
  indices?: number[]
}

/** 顶点属性格式对应的分量数 */
const FORMAT_COMPONENTS: Record<VertexAttributeFormat, number> = {
  'float32x2': 2,
  'float32x3': 3,
  'float32x4': 4,
}

export const jsonModelLoader: AssetTypeLoader<Model> = {
  type: 'model',
  extensions: ['.model.json'] as const,
  async load(id, parsedId, ctx) {
    const relativePath = `assets/${parsedId.namespace}/${parsedId.path}`
    const text = await ctx.fs.readText(relativePath)
    let parsed: ModelFile
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`[model] JSON 解析失败（id: ${id}）: ${(err as Error).message}`)
    }

    return buildModel(id, parsed)
  },
}

/** 把 .model.json 解析为 engine Model */
function buildModel(id: string, parsed: ModelFile): Model {
  if (!parsed.attributes || parsed.attributes.length === 0) {
    throw new Error(`[model] 缺少 attributes 声明（id: ${id}）`)
  }
  if (!parsed.vertices || parsed.vertices.length === 0) {
    throw new Error(`[model] 缺少 vertices 数据（id: ${id}）`)
  }

  // 计算每个属性的分量数 + 字节偏移 + arrayStride
  const attrComps = parsed.attributes.map((a) => FORMAT_COMPONENTS[a.format])
  const strideFloats = attrComps.reduce((s, c) => s + c, 0)
  const strideBytes = strideFloats * 4

  const attributes: VertexAttribute[] = []
  let offsetBytes = 0
  for (let i = 0; i < parsed.attributes.length; i++) {
    attributes.push({
      shaderLocation: i,
      offset: offsetBytes,
      format: parsed.attributes[i].format,
    })
    offsetBytes += attrComps[i] * 4
  }

  // 展平 vertices 二维数组 → Float32Array，校验每行分量数
  const vertexCount = parsed.vertices.length
  const flat = new Float32Array(vertexCount * strideFloats)
  for (let i = 0; i < vertexCount; i++) {
    const row = parsed.vertices[i]
    if (!Array.isArray(row) || row.length !== strideFloats) {
      throw new Error(`[model] 顶点 ${i} 分量数 ${row?.length ?? '?'} ≠ attributes 要求 ${strideFloats}（id: ${id}）`)
    }
    for (let j = 0; j < strideFloats; j++) {
      flat[i * strideFloats + j] = row[j]
    }
  }

  // 索引（可选）
  let indices: Uint16Array | undefined
  if (parsed.indices && parsed.indices.length > 0) {
    if (vertexCount > 65535) {
      throw new Error(`[model] 顶点数 ${vertexCount} 超过 Uint16 索引上限 65535（暂不支持 Uint32）`)
    }
    // 校验索引范围
    for (let i = 0; i < parsed.indices.length; i++) {
      const idx = parsed.indices[i]
      if (idx < 0 || idx >= vertexCount) {
        throw new Error(`[model] 索引 ${idx} 越界（顶点数 ${vertexCount}，位置 ${i}，id: ${id}）`)
      }
    }
    indices = new Uint16Array(parsed.indices)
  }

  const vertexLayouts: VertexLayout[] = [
    {
      arrayStride: strideBytes,
      attributes,
    },
  ]

  return {
    id,
    vertices: flat,
    indices,
    vertexLayouts,
  }
}
