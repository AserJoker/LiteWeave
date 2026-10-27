/**
 * WebGPU 设备与 canvas 配置辅助（Runner 渲染进程专用）。
 *
 * 设计见 docs/design/runner-render-pipeline.md §3。
 *
 * 本里程碑（三角形）只暴露最小能力：
 * - getGpuDevice()：请求 adapter + device，附 device.lost 监听
 * - configureCanvas()：canvas.getContext('webgpu') + ctx.configure
 * - resizeCanvasToDisplaySize()：高 DPI 感知的尺寸同步
 * - getAdapterInfo()：从 adapter 提取人类可读信息（卡片显示用）
 *
 * 不做：swapchain 重建（WebGPU 自动管理）、多采样、纹理格式枚举（用 getPreferredCanvasFormat）。
 */

/** 设备初始化结果：device + adapter（adapter 用于信息卡片显示） */
export interface GpuDeviceHandle {
  device: GPUDevice
  adapter: GPUAdapter
  /** canvas format（getPreferredCanvasFormat 结果，configure 与 pipeline 必须共用） */
  format: GPUTextureFormat
}

/**
 * 请求 GPU adapter + device。
 * 失败抛错（调用方捕获后显示在状态卡片）。
 */
export async function getGpuDevice(): Promise<GpuDeviceHandle> {
  if (!('gpu' in navigator)) {
    throw new Error('当前环境不支持 WebGPU（需 Electron 44+ / Chromium 152+，或浏览器未启用 WebGPU）')
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  })
  if (!adapter) {
    throw new Error('未找到可用 GPU adapter（请检查显卡驱动是否支持 WebGPU）')
  }
  const device = await adapter.requestDevice({
    requiredFeatures: [],
    requiredLimits: {},
  })

  // device.lost：运行时 GPU 设备丢失（驱动崩溃 / 内存压力等），上报到调用方
  device.lost.then((info) => {
    console.error(`[gpu] device lost: reason=${info.reason}, message=${info.message}`)
  })

  // 全局未捕获错误（validation / out-of-memory 等）
  device.addEventListener('uncapturederror', (event) => {
    console.error(`[gpu] uncaptured error: ${event.error.message}`)
  })

  const format = navigator.gpu.getPreferredCanvasFormat()
  return { device, adapter, format }
}

/**
 * 配置 canvas 的 WebGPU context。
 * 返回 GPUCanvasContext，每帧调 getCurrentTexture() 取 swapchain 纹理。
 */
export function configureCanvas(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  format: GPUTextureFormat,
): GPUCanvasContext {
  const ctx = canvas.getContext('webgpu') as unknown as GPUCanvasContext | null
  if (!ctx) {
    throw new Error('canvas.getContext("webgpu") 返回 null（环境不支持 WebGPU canvas）')
  }
  ctx.configure({
    device,
    format,
    // 三角形 demo 不需要透明合成；opaque 让 swapchain 忽略 alpha 通道
    alphaMode: 'opaque',
  })
  return ctx
}

/**
 * 同步 canvas 物理像素尺寸到 CSS 显示尺寸（乘 dpr）。
 * 返回尺寸是否变化（变化时下一帧 getCurrentTexture 会返回新尺寸纹理，WebGPU 自动重建 swapchain）。
 */
export function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): boolean {
  const dpr = window.devicePixelRatio || 1
  const displayWidth = Math.max(1, Math.floor(canvas.clientWidth * dpr))
  const displayHeight = Math.max(1, Math.floor(canvas.clientHeight * dpr))
  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth
    canvas.height = displayHeight
    return true
  }
  return false
}

/** adapter 信息提取（信息卡片显示用，人类可读） */
export function getAdapterInfo(adapter: GPUAdapter): {
  vendor: string
  architecture: string
  description: string
} {
  // adapter.info 在 Chromium 152+ 可用；旧版本字段为空字符串
  const info = adapter.info ?? ({} as GPUAdapterInfo)
  return {
    vendor: info.vendor || 'unknown',
    architecture: info.architecture || 'unknown',
    description: info.description || `${info.vendor || 'GPU'} ${info.architecture || ''}`.trim(),
  }
}
