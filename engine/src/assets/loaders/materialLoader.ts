/**
 * Material 资源 loader —— 解析 .mat.json 为 engine Material 描述对象。
 *
 * 文件格式（与 Material 接口三段式对齐，见 types.ts Material 注释）：
 * ```json
 * {
 *   "id": "demogame:materials/cube-vertex-color",
 *   "name": "立方体顶点色材质",
 *   "metadata": { ... Schema 定义 ... },
 *   "fields": { "baseColor": [1,0,0,1], "roughness": 0.5 },
 *   "pipelineBindings": {
 *     "pipeline:cube-opaque": { "mvp": "modelViewProj" }
 *   }
 * }
 * ```
 *
 * 字段说明：
 * - id：资产 id（<namespace>:<path>，与资源 id 一致；loader 用传入的 id 覆盖文件内 id 保证一致）
 * - name：展示名（可选，缺省取 path 文件名）
 * - metadata：Schema 定义（配合 IDE SchemaForm；当前 demo 可为 {}）
 * - fields：静态字段值（key=语义名，value=数字/数组/对象；Float32Array 类字段由 Renderer 写入 UBO 时转换）
 * - pipelineBindings：字段→shader uniform 映射（二层 kv）
 *
 * 加载策略：
 * - JSON 直接解析，字段透传
 * - id 用 loader 入参的 id 覆盖（保证与资源寻址一致，防止文件内 id 写错）
 * - 不递归加载依赖（Material 不引用其他资产）
 */
import type { AssetTypeLoader } from '../types.js'
import type { Material } from '../../types.js'

/** .mat.json 文件结构（与 Material 接口对齐，但 id 可选） */
interface MaterialFile {
  name?: string
  metadata?: Record<string, unknown>
  fields?: Record<string, unknown>
  pipelineBindings?: Record<string, Record<string, string>>
}

export const materialLoader: AssetTypeLoader<Material> = {
  type: 'material',
  extensions: ['.mat.json'] as const,
  async load(id, parsedId, ctx) {
    const relativePath = `assets/${parsedId.namespace}/${parsedId.path}`
    const text = await ctx.fs.readText(relativePath)
    let parsed: MaterialFile
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`[material] JSON 解析失败（id: ${id}）: ${(err as Error).message}`)
    }

    // 默认名取文件名（去后缀）
    const defaultName = parsedId.path
      .split('/')
      .pop()!
      .replace(/\.mat\.json$/i, '')

    // 静态字段后处理：数组值转 Float32Array（Renderer UniformBuffer 写入需要）
    const rawFields = parsed.fields ?? {}
    const fields: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(rawFields)) {
      if (Array.isArray(val)) {
        fields[key] = new Float32Array(val)
      } else {
        fields[key] = val
      }
    }

    return {
      id,
      name: parsed.name ?? defaultName,
      metadata: parsed.metadata ?? {},
      fields,
      pipelineBindings: parsed.pipelineBindings ?? {},
    }
  },
}
