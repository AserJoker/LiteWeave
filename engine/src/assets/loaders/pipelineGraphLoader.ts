/**
 * PipelineGraph 资源 loader —— 解析 .graph.json 为 engine PipelineGraph 描述对象。
 *
 * 文件格式（纯管线结构，不含 RO 实例数据）：
 * ```json
 * {
 *   "nodes": [
 *     {
 *       "name": "cube-pass",
 *       "pipeline": "demogame:pipelines/cube-opaque.pipeline.json",
 *       "colorAttachmentInputs": [],
 *       "colorAttachmentOutputs": ["offscreen-color"],
 *       "depthAttachment": "offscreen-depth"
 *     },
 *     {
 *       "name": "present-pass",
 *       "pipeline": "demogame:pipelines/present.pipeline.json",
 *       "colorAttachmentInputs": ["offscreen-color"],
 *       "colorAttachmentOutputs": ["swapchain"]
 *     }
 *   ],
 *   "edges": [
 *     { "attachment": "offscreen-color", "from": "cube-pass", "to": "present-pass", "toBinding": 0 }
 *   ],
 *   "attachments": [ ...Attachment... ]
 * }
 * ```
 *
 * 关键设计：
 * - pipeline 用资源 id 引用，loader 通过 ctx.loadAsset 递归加载为 Pipeline 对象引用
 *   （AssetLoader 缓存保证同一 id 返回同一实例 → Renderer 引用相等判断同一 GPU 资源）
 * - 不再持 renderObjects（RO 归 Scene 资源；Scene 通过 material.pipelineBindings 的 key 集合
 *   声明每个 RO 在哪些 pipeline 可见，Renderer 渲染某 pass 时按 node.pipeline.id 筛选 RO）
 * - PipelineGraph.id 运行时生成（createRuntimeId），graph.json 不持
 * - Attachment 直接透传（含 swapchain 类型，format 字段透传；swapchain format 由 runner 在创建 graph 前替换）
 */
import type { AssetTypeLoader } from '../types.js'
import type {
  PipelineGraph,
  PipelineNode,
  Attachment,
  AttachmentEdge,
  Pipeline,
} from '../../types.js'
import { createRuntimeId } from '../../ids.js'

/** 节点模板（graph.json 中的 PipelineNode 描述，pipeline 用 id 引用） */
interface NodeTemplate {
  name: string
  pipeline: string // pipeline 资产 id
  colorAttachmentInputs: string[]
  colorAttachmentOutputs: string[]
  depthAttachment?: string
}

/** .graph.json 文件结构 */
interface PipelineGraphFile {
  nodes: NodeTemplate[]
  edges: AttachmentEdge[]
  attachments: Attachment[]
}

export const pipelineGraphLoader: AssetTypeLoader<PipelineGraph> = {
  type: 'pipeline-graph',
  extensions: ['.graph.json'] as const,
  async load(id, parsedId, ctx) {
    const relativePath = `assets/${parsedId.namespace}/${parsedId.path}`
    const text = await ctx.fs.readText(relativePath)
    let parsed: PipelineGraphFile
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`[pipeline-graph] JSON 解析失败（id: ${id}）: ${(err as Error).message}`)
    }

    // 递归加载所有节点的 pipeline（连带加载 shader）
    const nodes: PipelineNode[] = []
    for (const nodeTpl of parsed.nodes) {
      const pipeline = await ctx.loadAsset<Pipeline>(nodeTpl.pipeline)
      nodes.push({
        name: nodeTpl.name,
        pipeline,
        colorAttachmentInputs: nodeTpl.colorAttachmentInputs,
        colorAttachmentOutputs: nodeTpl.colorAttachmentOutputs,
        depthAttachment: nodeTpl.depthAttachment,
      })
    }

    return {
      id: createRuntimeId(),
      nodes,
      edges: parsed.edges,
      attachments: parsed.attachments,
    }
  },
}
