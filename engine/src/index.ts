/**
 * @liteweave/engine 公共 API 入口。
 *
 * 分两层：
 * - 数据描述对象（types.ts）：上层用这些对象描述场景（不耦合 WebGPU）
 * - WebGPU Renderer（webgpu/Renderer.ts）：把描述对象编译为 GPU 资源并按 PipelineGraph 渲染
 *
 * demo/ 下是历史硬编码 demo 的残留工具（已不再被外部使用，待清理）。
 */
export * from './types.js'
export { createRuntimeId } from './ids.js'
export { Renderer, type RendererInit } from './webgpu/Renderer.js'
export { Camera } from './Camera.js'
export * from './assets/index.js'
