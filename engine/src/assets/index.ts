/**
 * Asset 模块公共 API。
 *
 * 分三层：
 * - types.ts：接口契约（AssetLoader/AssetTypeLoader/FileSystemAdapter 等）
 * - registry.ts：AssetTypeRegistry 实现（type → loader 注册表）
 * - loader.ts：AssetLoader 实现（id → 描述对象，带缓存 + 递归加载）
 * - loaders/：内置 AssetTypeLoader 实现（model/material/pipeline/pipeline-graph/shader）
 *
 * 典型用法：
 * ```ts
 * const registry = createAssetTypeRegistry()
 * registerBuiltinLoaders(registry)
 * const loader = new AssetLoader({
 *   projectRoot, namespaces, defaultNamespace,
 *   fs: ipcFileSystemAdapter,  // app/runner 注入
 *   registry,
 *   manifest: projectJson.resources,
 * })
 * const graph = await loader.loadAsset<PipelineGraph>('demogame:graphs/cube.graph.json')
 * renderer.renderGraph(graph)
 * ```
 */
export * from './types.js'
export { createAssetTypeRegistry } from './registry.js'
export { AssetLoader, extractExtension, type AssetLoaderOptions } from './loader.js'
export { registerBuiltinLoaders } from './loaders/index.js'
// 内置 loader 单独导出（供测试或自定义注册）
export { jsonModelLoader } from './loaders/modelLoader.js'
export { materialLoader } from './loaders/materialLoader.js'
export { pipelineLoader } from './loaders/pipelineLoader.js'
export { pipelineGraphLoader } from './loaders/pipelineGraphLoader.js'
export { sceneLoader } from './loaders/sceneLoader.js'
export { shaderLoader } from './loaders/shaderLoader.js'
