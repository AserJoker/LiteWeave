/**
 * 内置 AssetTypeLoader 注册入口。
 *
 * 注册 6 个系统内置 type：
 * - shader：.wgsl/.vert/.frag/.comp/.glsl → string
 * - model：.model.json → Model（自定义 JSON 几何格式，支持任意顶点属性）
 * - material：.mat.json → Material
 * - pipeline：.pipeline.json → Pipeline（递归加载 shader）
 * - pipeline-graph：.graph.json → PipelineGraph（递归加载 pipeline；不含 RO）
 * - scene：.scene.json → Scene（递归加载 graph + 每 RO 的 model/material）
 *
 * 插件可在 engine 启动后调 registry.register 注册自定义 type（如 .texture/.particle.json）。
 */
import type { AssetTypeRegistry } from '../types.js'
import { shaderLoader } from './shaderLoader.js'
import { jsonModelLoader } from './modelLoader.js'
import { materialLoader } from './materialLoader.js'
import { pipelineLoader } from './pipelineLoader.js'
import { pipelineGraphLoader } from './pipelineGraphLoader.js'
import { sceneLoader } from './sceneLoader.js'

/** 注册所有内置 AssetTypeLoader 到 registry */
export function registerBuiltinLoaders(registry: AssetTypeRegistry): void {
  registry.register(shaderLoader)
  registry.register(jsonModelLoader)
  registry.register(materialLoader)
  registry.register(pipelineLoader)
  registry.register(pipelineGraphLoader)
  registry.register(sceneLoader)
}
