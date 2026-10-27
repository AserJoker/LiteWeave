/**
 * Renderer 内部 GPU 资源类型（不对外暴露，Renderer 实现细节）。
 *
 * 这些类型与 WebGPU 强耦合；上层（types.ts）只看数据描述对象。
 * 缓存 key 用 id（资产用外部 id，运行时对象用内部 id）。
 */

/** Model 编译后的 GPU 资源：vertex buffer + index buffer */
export interface GpuModel {
  /** null = 无 vertex buffer（全屏三角形等用 @builtin(vertex_index) 内嵌生成） */
  vertexBuffer: GPUBuffer | null
  indexBuffer: GPUBuffer | null
  indexCount: number
}

/** Pipeline 编译后的 GPU 资源：GPURenderPipeline + bindGroupLayout（来自 pipeline.bindings） */
export interface GpuPipeline {
  pipeline: GPURenderPipeline
  /** null = 0 binding；非 null 时用于创建 bindGroup */
  bindGroupLayout: GPUBindGroupLayout | null
  /** shaderModule（用于错误诊断或未来 shader 反射） */
  shaderModule: GPUShaderModule
}

/** Attachment 编译后的 GPU 资源：纹理 + view（swapchain 类型每帧由 Renderer 取，不缓存） */
export interface GpuAttachment {
  texture: GPUTexture
  view: GPUTextureView
  width: number
  height: number
}

/**
 * RenderObject 在某 pipeline 下的 UniformBuffer 实例（持续存在，每帧复写数据）。
 *
 * 设计（见 memory: experience_architecture_gpu-cache-lifecycle）：
 * - Pipeline 模板 + per-RO 实例：UniformBuffer 由 Pipeline 定义结构，每个 RO 独立一份
 * - 持续存在：buffer 在 RO 首次被该 pipeline 渲染时创建，每帧只 writeBuffer 复写数据
 * - 生命周期跟随 RO：RO 释放时一起 destroy
 * - key 用 shader uniform 名（如 'mvp'），value = offset + 当前数据
 */
export interface GpuUniformBufferInstance {
  /** GPU uniform buffer（持续存在） */
  gpuBuffer: GPUBuffer
  /** 字节总大小（按 16 字节对齐，WebGPU uniform buffer 规范） */
  size: number
  /**
   * 字段当前数据（key = shader uniform 名，如 'mvp'）。
   * 用于 writeBuffer 时按 offset 写入对应字段。
   * 静态字段（来自 Material.fields）写入一次后保持不变；
   * 可变字段（来自 RenderObject.fieldValues）每帧更新。
   */
  values: Map<string, { offset: number; data: Float32Array }>
}

/** 离屏渲染目标（color + depth） */
export interface GpuRenderTarget {
  color: GpuAttachment
  depth: GpuAttachment | null
  width: number
  height: number
}
