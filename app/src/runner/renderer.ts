/**
 * 主线程渲染状态机 + GPU 资源管理 + 命令消费。
 *
 * 从硬编码渲染沉淀而来。消费 Worker frame 命令，驱动 rAF 渲染。
 * 主线程感知 PipelineGraph，不感知 Scene/Camera（只存 view/projection 矩阵）。
 *
 * 详见 docs/design/engine-redesign.md §7。
 */
import { mat4 } from 'gl-matrix'
import type { Command } from './protocol'

/** 内置资源 id 前缀（不随 scene 销毁，reload 重建） */
export const BUILTIN_PREFIX = '__builtin:'
/** 内置资源 id 约定 */
export const BUILTIN_IDS = {
  quad: '__builtin:quad', // 全屏四边形（NDC -1..1，position@0 float32x2 + uv@1 float32x2）
  white: '__builtin:white', // 1×1 白色纹理
  checker: '__builtin:checker', // 灰色棋盘纹理（纹理缺失 fallback）
} as const

/** 静态 GPU 资产缓存（id → GPU 对象 / 解析数据） */
interface AssetCache {
  graphs: Map<string, PipelineGraphRuntime>
  pipelines: Map<string, GPURenderPipeline>
  pipelineBindings: Map<string, PipelineBindingDecl[]> // pipelineId → binding 描述（按 binding 号排序）
  shaders: Map<string, GPUShaderModule>
  models: Map<string, { vertexBuffer: GPUBuffer; indexBuffer: GPUBuffer; indexCount: number; stride: number }>
  materials: Map<string, MaterialDesc>
  textures: Map<string, GPUTexture>
}

interface PipelineGraphRuntime {
  passes: { name: string; pipelineId: string; colorOutputs: string[]; depthOutput?: string; colorInputs: string[] }[]
  attachmentDecls: Map<string, AttachmentDecl>
}

/** pipeline binding 描述（从 pipeline JSON 的 bindings 数组解析） */
interface PipelineBindingDecl {
  binding: number
  kind: 'uniform-buffer' | 'sampled-texture' | 'sampler'
  visibility: 'vertex' | 'fragment' | 'compute'
  scope?: 'global' | 'instance' // uniform-buffer 专用
  bufferSize?: number // uniform-buffer 专用
  textureFormat?: string // sampled-texture 专用
}

interface AttachmentDecl {
  name: string
  kind: string
  format: string
  sizeMode: string
  sampledByLaterPass: boolean
}

interface MaterialDesc {
  pipelineBindings: Record<string, Record<string, string>>
  fields: Record<string, unknown>
}

/** RO 运行时（主线程状态机） */
interface RORuntime {
  name: string
  modelId: string
  materialId: string
  pipelineBindings: Record<string, Record<string, string>>
  fields: Map<string, Float32Array>
  locked: boolean
  uniformBuffers: Map<string, GPUBuffer> // pipelineId → instance uniform buffer
}

/** 主线程渲染状态机 */
export class Renderer {
  private device: GPUDevice
  private context: GPUCanvasContext
  private format: GPUTextureFormat
  private canvas: HTMLCanvasElement
  private depthTexture: GPUTexture | null = null
  private attachments = new Map<string, GPUTexture>()
  private sampler: GPUSampler | null = null

  private assets: AssetCache = {
    graphs: new Map(),
    pipelines: new Map(),
    pipelineBindings: new Map(),
    shaders: new Map(),
    models: new Map(),
    materials: new Map(),
    textures: new Map(),
  }

  /** canvas 尺寸变化回调（main.ts 注册后推 resize 事件给 Worker） */
  onResize: ((width: number, height: number) => void) | null = null

  private ros = new Map<string, RORuntime>()
  private viewProjection: { view: Float32Array; projection: Float32Array } | null = null
  private globalUniforms = new Map<string, GPUBuffer>() // pipelineId → global uniform buffer

  private frameCount = 0
  private rafId = 0
  private resizeObserver: ResizeObserver | null = null

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, canvas: HTMLCanvasElement) {
    this.device = device
    this.context = context
    this.format = format
    this.canvas = canvas
    // 捕获 WebGPU validation 错误（不抛 JS 异常，需主动监听）
    device.addEventListener('uncapturederror', (ev) => {
      console.error('[renderer] WebGPU uncaptured error:', (ev as GPUUncapturedErrorEvent).error.message)
    })
  }

  /** 启动渲染循环 */
  start(): void {
    this.initBuiltinAssets()
    const resize = () => this.handleResize()
    resize()
    this.resizeObserver = new ResizeObserver(resize)
    this.resizeObserver.observe(this.canvas)
    // 用 setTimeout 而非 rAF：Runner 窗口常被 IDE 遮挡（document.hidden=true），
    // rAF 在 hidden 时不触发（即使 backgroundThrottling:false）。
    // WebGPU 提交不依赖 VSync，setTimeout ~60fps 足够。
    const frame = () => {
      this.render()
      this.rafId = window.setTimeout(frame, 16) as unknown as number
    }
    this.rafId = window.setTimeout(frame, 16) as unknown as number
  }

  /** 清空所有状态（握手协议：Worker reload 时调用） */
  clear(): void {
    for (const ro of this.ros.values()) {
      for (const b of ro.uniformBuffers.values()) b.destroy()
    }
    this.ros.clear()
    for (const b of this.globalUniforms.values()) b.destroy()
    this.globalUniforms.clear()
    for (const t of this.attachments.values()) t.destroy()
    this.attachments.clear()
    this.depthTexture?.destroy()
    this.depthTexture = null
    this.viewProjection = null
    // 静态资产缓存也清空（reload 全量重置）
    for (const m of this.assets.models.values()) {
      m.vertexBuffer.destroy()
      m.indexBuffer.destroy()
    }
    this.assets = { graphs: new Map(), pipelines: new Map(), pipelineBindings: new Map(), shaders: new Map(), models: new Map(), materials: new Map(), textures: new Map() }
    // 重建内置资源（永生：不随 scene 销毁，但 reload 重建）
    this.initBuiltinAssets()
  }

  /** 预建内置资源（quad/white/checker），约定 id `__builtin:` 前缀 */
  private initBuiltinAssets(): void {
    // __builtin:quad —— 全屏四边形（NDC -1..1，position@0 float32x2 + uv@1 float32x2，stride 16）
    {
      const vertexData = new Float32Array([
        -1, -1, 0, 0,
        1, -1, 1, 0,
        1, 1, 1, 1,
        -1, 1, 0, 1,
      ])
      const indexData = new Uint16Array([0, 1, 2, 0, 2, 3])
      const vertexBuffer = this.device.createBuffer({ size: vertexData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      this.device.queue.writeBuffer(vertexBuffer, 0, vertexData)
      const indexBuffer = this.device.createBuffer({ size: indexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
      this.device.queue.writeBuffer(indexBuffer, 0, indexData)
      this.assets.models.set(BUILTIN_IDS.quad, { vertexBuffer, indexBuffer, indexCount: indexData.length, stride: 16 })
    }
    // __builtin:white —— 1×1 白色 rgba8unorm 纹理
    this.assets.textures.set(BUILTIN_IDS.white, this.createSolidTexture(255, 255, 255, 255))
    // __builtin:checker —— 8×8 灰色棋盘 rgba8unorm 纹理（纹理缺失 fallback）
    this.assets.textures.set(BUILTIN_IDS.checker, this.createCheckerTexture())
    console.log('[renderer] 内置资源已预建: quad, white, checker')
  }

  /** 建 1×1 纯色纹理 */
  private createSolidTexture(r: number, g: number, b: number, a: number): GPUTexture {
    const tex = this.device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    this.device.queue.writeTexture({ texture: tex }, new Uint8Array([r, g, b, a]), { bytesPerRow: 4 }, [1, 1])
    return tex
  }

  /** 建 8×8 灰色棋盘纹理（深灰/浅灰交替） */
  private createCheckerTexture(): GPUTexture {
    const size = 8
    const data = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        const v = ((x + y) % 2 === 0) ? 200 : 100
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
      }
    }
    const tex = this.device.createTexture({
      size: [size, size],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    this.device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: size * 4 }, [size, size])
    return tex
  }

  /** 批量加载资产（收字节 → 按类型分流建 GPU 对象） */
  async loadAssets(results: Record<string, Uint8Array | { error: string }>): Promise<void> {
    // 两轮：先建非 pipeline 资产（shader/model/material/graph/texture），
    // 再建 pipeline（依赖 shader，此时已就绪）。
    const pipelineIds: string[] = []
    for (const [id, data] of Object.entries(results)) {
      if (!(data instanceof Uint8Array)) {
        console.error(`[renderer] 资产加载失败 ${id}:`, (data as { error: string }).error)
        continue
      }
      if (id.endsWith('.pipeline.json')) {
        pipelineIds.push(id)
        continue
      }
      try {
        this.buildAsset(id, data)
      } catch (err) {
        console.error(`[renderer] 资产构建失败 ${id}:`, err)
      }
    }
    for (const id of pipelineIds) {
      try {
        this.buildAsset(id, results[id] as Uint8Array)
      } catch (err) {
        console.error(`[renderer] 资产构建失败 ${id}:`, err)
      }
    }
  }

  /** 按 id 后缀分流建 GPU 对象 */
  private buildAsset(id: string, data: Uint8Array): void {
    if (id.endsWith('.graph.json')) this.buildGraph(id, data)
    else if (id.endsWith('.pipeline.json')) this.buildPipeline(id, data)
    else if (id.endsWith('.wgsl') || id.endsWith('.shader')) this.buildShader(id, data)
    else if (id.endsWith('.model.json')) this.buildModel(id, data)
    else if (id.endsWith('.mat.json')) this.buildMaterial(id, data)
    else if (id.endsWith('.png') || id.endsWith('.jpg') || id.endsWith('.jpeg')) this.buildTexture(id, data)
    else console.warn(`[renderer] 未知资产类型: ${id}`)
  }

  private buildGraph(id: string, data: Uint8Array): void {
    const json = JSON.parse(new TextDecoder().decode(data))
    const graph: PipelineGraphRuntime = {
      passes: json.nodes.map((n: { name: string; pipeline: string; colorAttachmentOutputs: string[]; depthAttachment?: string; colorAttachmentInputs: string[] }) => ({
        name: n.name,
        pipelineId: n.pipeline,
        colorOutputs: n.colorAttachmentOutputs ?? [],
        depthOutput: n.depthAttachment,
        colorInputs: n.colorAttachmentInputs ?? [],
      })),
      attachmentDecls: new Map(
        (json.attachments ?? []).map((a: { name: string; kind: string; format: string; size?: { mode?: string }; sampledByLaterPass?: boolean }) => [
          a.name,
          { name: a.name, kind: a.kind, format: a.format, sizeMode: a.size?.mode ?? 'swapchain', sampledByLaterPass: a.sampledByLaterPass ?? false },
        ]),
      ),
    }
    this.assets.graphs.set(id, graph)
  }

  private buildShader(id: string, data: Uint8Array): void {
    const code = new TextDecoder().decode(data)
    const module = this.device.createShaderModule({ code })
    this.assets.shaders.set(id, module)
  }

  private buildPipeline(id: string, data: Uint8Array): void {
    const desc = JSON.parse(new TextDecoder().decode(data))
    const shaderModule = this.assets.shaders.get(desc.shader)
    if (!shaderModule) throw new Error(`pipeline ${id} 依赖未加载的 shader: ${desc.shader}`)
    const pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: desc.vertexEntryPoint,
        buffers: (desc.vertexBufferLayouts ?? []).map((bl: { arrayStride: number; attributes: { shaderLocation: number; offset: number; format: GPUVertexFormat }[] }) => ({
          arrayStride: bl.arrayStride,
          attributes: bl.attributes,
        })),
      },
      fragment: {
        module: shaderModule,
        entryPoint: desc.fragmentEntryPoint,
        targets: (desc.colorTargets ?? []).map((t: { format?: GPUTextureFormat }) => ({ format: t.format ?? this.format })),
      },
      primitive: { topology: desc.topology ?? 'triangle-list', cullMode: desc.cullMode ?? 'none' },
      depthStencil: desc.depthState ? {
        format: desc.depthState.format,
        depthWriteEnabled: desc.depthState.depthWriteEnabled,
        depthCompare: desc.depthState.depthCompare,
      } : undefined,
    })
    this.assets.pipelines.set(id, pipeline)
    // 保存 binding 描述（render() 按 kind 组装 bindGroup 资源）
    const bindings: PipelineBindingDecl[] = (desc.bindings ?? []).map((b: { binding: number; kind: string; visibility?: string; scope?: string; bufferSize?: number; textureFormat?: string }) => ({
      binding: b.binding,
      kind: b.kind as PipelineBindingDecl['kind'],
      visibility: (b.visibility ?? 'fragment') as PipelineBindingDecl['visibility'],
      scope: b.scope as 'global' | 'instance' | undefined,
      bufferSize: b.bufferSize,
      textureFormat: b.textureFormat,
    })).sort((a: PipelineBindingDecl, b: PipelineBindingDecl) => a.binding - b.binding)
    this.assets.pipelineBindings.set(id, bindings)
  }

  private buildModel(id: string, data: Uint8Array): void {
    const json = JSON.parse(new TextDecoder().decode(data))
    const stride = json.attributes.reduce((s: number, a: { format: string }) => s + bytesPerAttr(a.format), 0)
    const vertexData = new Float32Array(json.vertices.flat())
    const indexData = new Uint16Array(json.indices)
    const vertexBuffer = this.device.createBuffer({ size: vertexData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(vertexBuffer, 0, vertexData)
    const indexBuffer = this.device.createBuffer({ size: indexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(indexBuffer, 0, indexData)
    this.assets.models.set(id, { vertexBuffer, indexBuffer, indexCount: json.indices.length, stride })
  }

  private buildMaterial(id: string, data: Uint8Array): void {
    const json = JSON.parse(new TextDecoder().decode(data))
    this.assets.materials.set(id, { pipelineBindings: json.pipelineBindings ?? {}, fields: json.fields ?? {} })
  }

  private buildTexture(id: string, _data: Uint8Array): void {
    // TODO: PNG 解码 → GPUTexture（当前 demo 无纹理，占位）
    console.warn(`[renderer] 纹理加载未实现: ${id}`)
  }

  /** 消费 frame 命令 */
  consumeCommands(commands: Command[]): void {
    for (const cmd of commands) {
      try {
        this.consumeCommand(cmd)
      } catch (err) {
        console.error('[renderer] 命令消费失败:', cmd.op, err)
      }
    }
  }

  private consumeCommand(cmd: Command): void {
    switch (cmd.op) {
      case 'addRO': {
        if (this.ros.has(cmd.name)) throw new Error(`RO name 冲突: ${cmd.name}`)
        const ro: RORuntime = {
          name: cmd.name,
          modelId: cmd.modelId,
          materialId: cmd.materialId,
          pipelineBindings: cmd.pipelineBindings,
          fields: new Map(),
          locked: false,
          uniformBuffers: new Map(),
        }
        if (cmd.initialFields) {
          for (const [k, v] of Object.entries(cmd.initialFields)) ro.fields.set(k, new Float32Array(v))
        }
        this.ros.set(cmd.name, ro)
        break
      }
      case 'removeRO': {
        const ro = this.ros.get(cmd.name)
        if (ro) {
          for (const b of ro.uniformBuffers.values()) b.destroy()
          this.ros.delete(cmd.name)
        }
        break
      }
      case 'setField': {
        const ro = this.ros.get(cmd.name)
        if (ro && !ro.locked) ro.fields.set(cmd.field, new Float32Array(cmd.value))
        break
      }
      case 'lockRO': {
        const ro = this.ros.get(cmd.name)
        if (ro) ro.locked = true
        break
      }
      case 'unlockRO': {
        const ro = this.ros.get(cmd.name)
        if (ro) ro.locked = false
        break
      }
      case 'setViewProjection': {
        // Worker 推 view/projection，主线程只存不改（脚本负责按 canvas aspect 算正确 projection）。
        // 不做二次 aspect 修正：脚本已是决策层，主线程不感知 Scene/Camera，只存扁平矩阵。
        this.viewProjection = { view: new Float32Array(cmd.view), projection: new Float32Array(cmd.projection) }
        break
      }
      case 'createDynamicBuffer':
      case 'writeDynamicBuffer':
      case 'destroyDynamicBuffer':
        // TODO: 动态资产（骨骼动画等），当前 demo 不用
        break
    }
  }

  private handleResize(): void {
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr))
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
      this.depthTexture?.destroy()
      this.depthTexture = this.device.createTexture({ size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT })
      // attachment 全删，下帧 lazy 重建
      for (const t of this.attachments.values()) t.destroy()
      this.attachments.clear()
      // 通知外部（main.ts 推 resize 事件给 Worker，脚本据此重算 projection）
      this.onResize?.(w, h)
    }
  }

  private render(): void {
    if (!this.viewProjection) return
    // 取第一个 graph（MVP 单 graph）
    const graph = this.assets.graphs.values().next().value as PipelineGraphRuntime | undefined
    if (!graph) return

    const { device, context, format } = this
    const commandEncoder = device.createCommandEncoder()

    for (const pass of graph.passes) {
      const pipeline = this.assets.pipelines.get(pass.pipelineId)
      if (!pipeline) continue

      // 解析 pass 输出 attachment：swapchain 直出，否则 lazy 建离屏纹理
      let colorView: GPUTextureView
      let isSwapchain = false
      if (pass.colorOutputs.length === 0) continue
      const outName = pass.colorOutputs[0]
      if (outName === 'swapchain') {
        colorView = context.getCurrentTexture().createView()
        isSwapchain = true
      } else {
        colorView = this.ensureAttachment(outName).createView()
      }

      const depthView = pass.depthOutput ? this.ensureAttachment(pass.depthOutput).createView() : (isSwapchain ? this.depthTexture?.createView() : undefined)

      const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [{ view: colorView, clearValue: { r: 0.1, g: 0.1, b: 0.12, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: depthView ? { view: depthView, depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' } : undefined,
      })
      renderPass.setPipeline(pipeline)

      // 按 pipeline binding 描述组装 bindGroup 资源（区分 uniform/texture/sampler）
      const bindingDecls = this.assets.pipelineBindings.get(pass.pipelineId) ?? []

      // 遍历可见 RO（pipelineBindings 含本 pipelineId）
      for (const ro of this.ros.values()) {
        if (!(pass.pipelineId in ro.pipelineBindings)) continue
        const model = this.assets.models.get(ro.modelId)
        if (!model) continue

        // 按 binding kind 组装 entries
        const entries: { binding: number; resource: GPUBufferBinding | GPUTextureView | GPUSampler }[] = []
        for (const decl of bindingDecls) {
          if (decl.kind === 'uniform-buffer') {
            if (decl.scope === 'global') {
              const globalBuf = this.ensureGlobalUniform(pass.pipelineId)
              // 首次或每帧写 viewProjection（shader 内 VP 已由主线程算好）
              const vp = mat4.create()
              mat4.multiply(vp, this.viewProjection.projection, this.viewProjection.view)
              device.queue.writeBuffer(globalBuf, 0, new Float32Array(vp))
              entries.push({ binding: decl.binding, resource: { buffer: globalBuf } })
            } else {
              // instance uniform（modelMatrix，默认 identity；脚本可 setField 覆盖）
              const instBuf = this.ensureInstanceUniform(ro, pass.pipelineId)
              const mm = ro.fields.get('modelMatrix') ?? new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1])
              device.queue.writeBuffer(instBuf, 0, mm)
              entries.push({ binding: decl.binding, resource: { buffer: instBuf } })
            }
          } else if (decl.kind === 'sampled-texture') {
            // 采样 pass 的 colorInputs 对应 attachment（按 binding 顺序取）
            const inputName = pass.colorInputs[decl.binding] ?? pass.colorInputs[0]
            const tex = this.ensureAttachment(inputName)
            entries.push({ binding: decl.binding, resource: tex.createView() })
          } else if (decl.kind === 'sampler') {
            entries.push({ binding: decl.binding, resource: this.ensureSampler() })
          }
        }

        renderPass.setBindGroup(0, device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: entries as GPUBindGroupEntry[],
        }))
        renderPass.setVertexBuffer(0, model.vertexBuffer)
        renderPass.setIndexBuffer(model.indexBuffer, 'uint16')
        renderPass.drawIndexed(model.indexCount)
      }
      renderPass.end()
    }

    device.queue.submit([commandEncoder.finish()])
    this.frameCount++
  }

  private ensureAttachment(name: string): GPUTexture {
    let tex = this.attachments.get(name)
    if (tex) return tex
    const graph = this.assets.graphs.values().next().value as PipelineGraphRuntime | undefined
    const decl = graph?.attachmentDecls.get(name)
    const format = (decl?.format ?? this.format) as GPUTextureFormat
    tex = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.attachments.set(name, tex)
    return tex
  }

  private ensureGlobalUniform(pipelineId: string): GPUBuffer {
    let buf = this.globalUniforms.get(pipelineId)
    if (!buf) {
      buf = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      this.globalUniforms.set(pipelineId, buf)
    }
    return buf
  }

  private ensureInstanceUniform(ro: RORuntime, pipelineId: string): GPUBuffer {
    let buf = ro.uniformBuffers.get(pipelineId)
    if (!buf) {
      buf = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      ro.uniformBuffers.set(pipelineId, buf)
    }
    return buf
  }

  private ensureSampler(): GPUSampler {
    if (!this.sampler) {
      this.sampler = this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      })
    }
    return this.sampler
  }

  getFrameCount(): number { return this.frameCount }

  /** 渲染状态快照（供 IDE inspect 打印渲染信息：MVP 矩阵、RO、资产计数等） */
  inspect(): Record<string, unknown> {
    const vp = this.viewProjection
    const ros = [...this.ros.values()].map((ro) => ({
      name: ro.name,
      modelId: ro.modelId,
      materialId: ro.materialId,
      locked: ro.locked,
      fields: [...ro.fields.keys()],
    }))
    return {
      frameCount: this.frameCount,
      canvas: `${this.canvas.width}×${this.canvas.height}`,
      hasViewProjection: !!vp,
      view: vp ? Array.from(vp.view) : null,
      projection: vp ? Array.from(vp.projection) : null,
      assets: {
        graphs: this.assets.graphs.size,
        pipelines: this.assets.pipelines.size,
        pipelineBindings: [...this.assets.pipelineBindings.entries()].map(([id, bs]) => ({ id: id.slice(-35), bindings: bs.map(b => `${b.binding}:${b.kind}`) })),
        shaders: this.assets.shaders.size,
        models: this.assets.models.size,
        materials: this.assets.materials.size,
      },
      ros,
    }
  }
}

function bytesPerAttr(format: string): number {
  if (format === 'float32x3') return 12
  if (format === 'float32x2') return 8
  if (format === 'float32x4') return 16
  throw new Error(`未知顶点属性格式: ${format}`)
}
