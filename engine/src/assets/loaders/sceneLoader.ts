/**
 * Scene 资源 loader —— 解析 .scene.json 为 engine Scene 描述对象。
 *
 * 文件格式：
 * ```json
 * {
 *   "name": "主场景",
 *   "graph": "demogame:graphs/cube.graph.json",
 *   "camera": {
 *     "type": "perspective",
 *     "position": [0, 0, 4],
 *     "target":   [0, 0, 0],
 *     "up":       [0, 1, 0],
 *     "fov": 1.0472,
 *     "near": 0.1,
 *     "far": 100
 *   },
 *   "renderObjects": [
 *     {
 *       "model": "demogame:models/cube.model.json",
 *       "material": "demogame:materials/cube-vertex-color.mat.json",
 *       "pipelineBindings": {
 *         "demogame:pipelines/cube-opaque.pipeline.json": { "modelMatrix": "modelMatrix" }
 *       }
 *     },
 *     {
 *       "model": "demogame:models/quad.model.json",
 *       "material": "demogame:materials/present-fullscreen.mat.json",
 *       "pipelineBindings": {
 *         "demogame:pipelines/present.pipeline.json": {}
 *       }
 *     }
 *   ]
 * }
 * ```
 *
 * 字段说明：
 * - graph：PipelineGraph 资源 id（递归加载为 PipelineGraph 描述对象）
 * - camera：场景相机（type='perspective'|'orthographic' + 初始信息 position/target/up/fov/near/far；
 *   aspect 缺省由 Renderer 用 canvas 宽高比填充）。
 *   语义：scene.camera 是"初始相机状态"，编辑期定义；运行时脚本操作 Renderer 的
 *   currentCamera（初始值从 scene.camera 拷贝），scene.camera 本身不可变。
 * - renderObjects：静态 RO 列表
 *   - model/material：资源 id（递归加载为 Model/Material 描述对象）
 *   - pipelineBindings：RO 可变字段 → pipeline shader uniform 名映射（与 Material.pipelineBindings 对称）
 *   - fieldValues：可选；静态初始字段值（如 modelMatrix；缺省时 runner 后续动态注入）
 *
 * MVP 拆分（GPU 相乘）：
 * - viewProjection 由 Renderer 按 currentCamera（初始值来自 scene.camera，脚本可改）每帧计算写入全局 uniform（@binding(0)）
 * - modelMatrix 由 RO.fieldValues['modelMatrix'] 提供（runner 初始化或脚本更新）
 * - shader 内 mvp = viewProjection * modelMatrix
 *
 * RO 与 pass 的关联规则（不显式声明 passName）：
 * - RO 通过 material.pipelineBindings 的 key 集合声明自己在哪些 pipeline 可见
 * - Renderer 渲染某 pass 时按 node.pipeline.id ∈ ro.material.pipelineBindings 的 key 筛选 RO
 *
 * RO.id 由 loader 调 createRuntimeId() 生成（运行时内部 id，不可硬编码）。
 */
import type { AssetTypeLoader } from '../types.js'
import type { Scene, RenderObject, Camera } from '../../types.js'
import { createRuntimeId } from '../../ids.js'

/** .scene.json 文件结构 */
interface SceneFile {
  name?: string
  graph: string
  camera: Camera
  renderObjects: Array<{
    model: string
    material: string
    pipelineBindings?: Record<string, Record<string, string>>
  }>
}

export const sceneLoader: AssetTypeLoader<Scene> = {
  type: 'scene',
  extensions: ['.scene.json'] as const,
  async load(id, _parsedId, ctx) {
    let parsed: SceneFile
    try {
      parsed = JSON.parse(await ctx.fs.readText(`assets/${idToRelPath(id)}`))
    } catch (err) {
      throw new Error(`[scene] JSON 解析失败（id: ${id}）: ${(err as Error).message}`)
    }

    if (!parsed.graph) {
      throw new Error(`[scene] 缺少 graph 引用（id: ${id}）`)
    }
    if (!parsed.camera) {
      throw new Error(`[scene] 缺少 camera 配置（id: ${id}）`)
    }
    // camera.type 必填：'perspective'（已实现）| 'orthographic'（占位，参数待补）
    if (parsed.camera.type !== 'perspective' && parsed.camera.type !== 'orthographic') {
      throw new Error(`[scene] camera.type 必须是 'perspective' 或 'orthographic'（id: ${id}）`)
    }
    if (parsed.camera.type === 'orthographic') {
      throw new Error(`[scene] orthographic camera 暂未实现投影参数（id: ${id}）`)
    }
    if (!Array.isArray(parsed.renderObjects)) {
      throw new Error(`[scene] 缺少 renderObjects 列表（id: ${id}）`)
    }

    // 递归加载 graph（graph loader 内部再递归加载 pipeline/shader）
    const graph = await ctx.loadAsset<import('../../types.js').PipelineGraph>(parsed.graph)

    // 递归加载每个 RO 的 model + material
    const renderObjects: RenderObject[] = []
    for (let i = 0; i < parsed.renderObjects.length; i++) {
      const roTpl = parsed.renderObjects[i]
      if (!roTpl.model) {
        throw new Error(`[scene] RO[${i}] 缺少 model 引用（id: ${id}）`)
      }
      if (!roTpl.material) {
        throw new Error(`[scene] RO[${i}] 缺少 material 引用（id: ${id}）`)
      }
      const model = await ctx.loadAsset<import('../../types.js').Model>(roTpl.model)
      const material = await ctx.loadAsset<import('../../types.js').Material>(roTpl.material)
      renderObjects.push({
        id: createRuntimeId(),
        model,
        material,
        fieldValues: new Map(),
        pipelineBindings: roTpl.pipelineBindings ?? {},
      })
    }

    return {
      id,
      graph,
      camera: parsed.camera,
      renderObjects,
    }
  },
}

/** id → 相对项目根路径（与 AssetLoader.resolvePath 同语义） */
function idToRelPath(id: string): string {
  const colonIdx = id.indexOf(':')
  const ns = colonIdx >= 0 ? id.slice(0, colonIdx) : id
  const path = colonIdx >= 0 ? id.slice(colonIdx + 1) : id
  return `${ns}/${path}`
}
