/**
 * @liteweave/engine 公共 API 入口。
 *
 * 分两层：
 * - 数据描述对象（types.ts）：上层用这些对象描述场景（不耦合 WebGPU）
 * - WebGPU Renderer（webgpu/Renderer.ts）：把描述对象编译为 GPU 资源并按 PipelineGraph 渲染
 *
 * demo/ 下是当前阶段的硬编码 demo（立方体场景），后续会被资源加载/.scene 协议替代。
 */
export * from './types.js'
export { createRuntimeId } from './ids.js'
export { Renderer, type RendererInit } from './webgpu/Renderer.js'
export { buildCubeScene, updateCubeMvp, buildMvp } from './demo/cubeScene.js'
