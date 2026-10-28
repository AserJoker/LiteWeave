/**
 * WebGPU Renderer —— 把数据描述对象编译为 GPU 资源 + 按 PipelineGraph 渲染。
 *
 * 职责：
 * - 持 device / canvas ctx（GPU 资源管理权）
 * - 编译 Model / Pipeline 为 GPU 资源（带缓存，描述对象引用相等 = 同一 GPU 资源）
 *   Material 是纯数据描述（metadata+fields+pipelineBindings），不持有独立 GPU 资源，
 *   其静态字段在 UniformBuffer 实例创建时写入 RO 的 per-pipeline uniform buffer。
 * - 创建/重建 Attachment（离屏颜色+深度；swapchain 每帧取）
 * - 渲染 PipelineGraph：按节点顺序遍历，每节点 beginRenderPass + setPipeline + setBindGroup + drawIndexed
 *
 * 设计见 docs/design/engine-layer.md（待写）+ 反向沉淀路径（feedback_engine-implement-first-then-protocol）。
 *
 * 不做：场景图遍历/视锥剔除/排序优化（这些在更上层）；本 Renderer 只负责 graph 渲染。
 *
 * ---------------- 缓存生命周期设计契约 ----------------
 *
 * 引擎/脚本通讯边界（关键）：未来引擎主体不是 JS（native 后端），脚本与引擎间有天然隔离层，
 * 双方通讯只能用可序列化扁平数据（id / Handle），不能传对象引用。脚本持 Handle，引擎按 id 查描述对象。
 * 当前 demo 阶段引擎在 JS 内（直接传引用）是过渡形态，未来切 native 时 API 入参从"对象引用"改为"Handle"。
 *
 * 两类 id，决定缓存生命周期策略：
 *
 * 1. 持久化资产（Model/Pipeline）：外部稳定 id `<namespace>:<path>`，代码可硬编码
 *    Material 是纯数据描述（无 GPU 资源），不在缓存层级管理。
 * 2. 运行时对象（RenderObject/attachment）：内部 id（运行时生成，仅用于比较/打印/去重/Handle 标识，不可硬编码）
 *
 * 缓存按"资产 vs 运行时"分两类：
 *
 * 1. 持久化资产缓存（modelCache / pipelineCache）：
 *    - key = 资产 id（当前 demo 用引用相等是过渡，未来切 native 改 id）
 *    - 跟随场景切换做 diff 保留：场景切换 A→B 时按 id 集合做 set diff
 *      keep = A∩B（GPU 资源保留）；release = A-B（destroy）；create = B-A（按需）
 *    - 上层必须保证同一资产的描述对象引用稳定（资产加载器按 id 去重，不每次 new）
 *
 * 2. 运行时对象缓存（uniformBufferCache / attachmentCache）：
 *    - key = 运行时对象内部 id（当前 demo 用引用相等是过渡）
 *    - 跟随场景一刀切释放，不参与 diff
 *    - uniformBufferCache 二层 Map：Map<RO 内部 id, Map<pipeline id, GpuUniformBufferInstance>>
 *      UniformBuffer 实例 per-RO per-pipeline（同一 RO 在不同 pipeline 下各需独立 buffer）
 *      懒初始化：首次渲染时创建并写入静态字段（Material.fields 经映射）+ 可变字段（RO.fieldValues 经映射）
 *      每帧只 updateUniformBufferInstance 更新可变字段（引用相等则跳过 writeBuffer）
 *    - attachment 是 graph 内部纹理，不同 graph 同名 attachment 含义可能不同（按 graph 分桶避免冲突）
 *
 * 3. swapchain 永远跟随 Renderer（不归属任何场景）。
 *
 * 当前实现：4 个 Map 按 id 索引：
 *   - modelCache/pipelineCache: Map<资产外部 id, GPU 资源>
 *   - uniformBufferCache: Map<RO 内部 id, Map<pipeline id, GpuUniformBufferInstance>>
 *   - attachmentCache: Map<PipelineGraph 内部 id, Map<attachment 名, GPU 资源>>（按 graph 分桶）
 * renderGraph 检测 graph 引用变化时调 transitionGraph(old, new)：
 *   - 资产按 id 集合 diff（keep/release/create）
 *   - uniform/attachment 跟随旧 graph 一刀切释放
 *
 * 未来切换 native 时 API 入参从"对象引用"改为"Handle"（含内部 id 的扁平包装），
 * 描述对象类型定义保持不变。详见 memory: experience_architecture_gpu-cache-lifecycle。
 *
 * 关键契约：描述对象一旦提交给 Renderer 即不可变（id 相等 → 内容相等）。
 *           违反此契约会导致 diff 命中但 GPU 资源数据陈旧。
 *           需要修改资产时，新建描述对象（新 id），让缓存自然 diff/释放旧资源。
 */
import type {
  Model,
  Pipeline,
  RenderObject,
  PipelineGraph,
  PipelineNode,
  Attachment,
  PipelineBinding,
  VertexLayout,
  Scene,
  Camera,
} from '../types.js'
import type {
  GpuModel,
  GpuPipeline,
  GpuAttachment,
  GpuUniformBufferInstance,
} from './gpuResources.js'
import { mat4 } from 'gl-matrix'

/** 创建 Renderer 所需的初始化参数 */
export interface RendererInit {
  device: GPUDevice
  ctx: GPUCanvasContext
  /** swapchain format（getPreferredCanvasFormat） */
  swapchainFormat: GPUTextureFormat
}

export class Renderer {
  device: GPUDevice
  ctx: GPUCanvasContext
  swapchainFormat: GPUTextureFormat

  // 持久化资产缓存（key = 资产外部 id；跨场景 diff 保留）
  private modelCache = new Map<string, GpuModel>()
  private pipelineCache = new Map<string, GpuPipeline>()
  // per-RO UniformBuffer 实例缓存（二层 Map；跟随 RO 一刀切释放）
  // 第一层 key = RenderObject.id（运行时内部 id）
  // 第二层 key = Pipeline.id（资产外部 id）—— 同一 RO 在不同 pipeline 下有独立 UniformBuffer
  // 仅含 scope='instance' 字段（如 modelMatrix）
  private uniformBufferCache = new Map<number, Map<string, GpuUniformBufferInstance>>()
  // 全局 UniformBuffer 缓存（key = Pipeline.id；scope='global' 字段如 viewProjection）
  // 所有 RO 共享同一 buffer；Renderer 每帧按 currentCamera 算 VP 写入
  private globalUniformBufferCache = new Map<string, GpuUniformBufferInstance>()
  // Attachment 按 graph 分桶（key = graph.id, value = attachment name → 资源）；
  // 解决不同 graph 同名 attachment 复用错误；swapchain 类型不缓存（每帧取）
  private attachmentCache = new Map<number, Map<string, GpuAttachment>>()
  // 当前活跃 graph（renderGraph 检测变化时触发 transitionGraph 释放旧 graph 资源）
  private activeGraph: PipelineGraph | null = null
  // 当前活跃 scene（持 RO 列表；transitionGraph 用其收集 model id + 释放 UniformBuffer）
  private activeScene: Scene | null = null
  // 当前 view 矩阵（可变；脚本层持 Camera 对象算出后调 setView 同步进来）。
  // 初始值：renderGraph 首次调用时从 scene.camera 算（lookAt(position, target, up)）。
  // Renderer 不持 Camera 对象 —— Camera 是脚本层业务概念，跨层只传扁平矩阵数据（见隔离层契约）。
  private viewMatrix: Float32Array | null = null
  // 当前 projection 矩阵（可变；脚本层算后调 setProjection 同步进来）。
  // 初始值：renderGraph 首次调用时从 scene.camera 算（perspective(fov, aspect, near, far)，aspect 由 canvas 自动填）。
  private projectionMatrix: Float32Array | null = null
  // 当前 canvas 物理尺寸（attachment size='swapchain' 用；初始 perspective 的 aspect 也用此）
  private currentWidth = 0
  private currentHeight = 0

  constructor(init: RendererInit) {
    this.device = init.device
    this.ctx = init.ctx
    this.swapchainFormat = init.swapchainFormat
  }

  /* ---------------- 编译：描述 → GPU 资源 ---------------- */

  /** 编译 Model：创建 vertex + index buffer，写入数据 */
  compileModel(model: Model): GpuModel {
    const cached = this.modelCache.get(model.id)
    if (cached) return cached

    // 空 model（无 vertex buffer，如全屏三角形用 @builtin(vertex_index)）：vertexBuffer 设 null
    const vertexBuffer: GPUBuffer | null = model.vertices.byteLength > 0
      ? this.device.createBuffer({
          size: model.vertices.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
      : null
    if (vertexBuffer) {
      this.device.queue.writeBuffer(vertexBuffer, 0, model.vertices)
    }

    let indexBuffer: GPUBuffer | null = null
    let indexCount = 0
    if (model.indices) {
      indexBuffer = this.device.createBuffer({
        size: model.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(indexBuffer, 0, model.indices)
      indexCount = model.indices.length
    }

    const gpuModel: GpuModel = { vertexBuffer, indexBuffer, indexCount }
    this.modelCache.set(model.id, gpuModel)
    return gpuModel
  }

  /** visibility 字符串 → GPUShaderStage flags */
  private parseVisibility(v: 'vertex' | 'fragment' | 'vertex+fragment'): GPUShaderStageFlags {
    if (v === 'vertex') return GPUShaderStage.VERTEX
    if (v === 'fragment') return GPUShaderStage.FRAGMENT
    return GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
  }

  /** PipelineBinding → GPUBindGroupLayoutEntry */
  private pipelineBindingToLayoutEntry(b: PipelineBinding): GPUBindGroupLayoutEntry {
    const visibility = this.parseVisibility(b.visibility)
    if (b.kind === 'uniform-buffer') {
      return { binding: b.binding, visibility, buffer: { type: 'uniform' } }
    }
    if (b.kind === 'sampled-texture') {
      return { binding: b.binding, visibility, texture: { sampleType: 'float' } }
    }
    return { binding: b.binding, visibility, sampler: { type: 'filtering' } }
  }

  /** 编译 Pipeline：创建 GPURenderPipeline（含 shader/binding layout/深度/剔除状态） */
  compilePipeline(pipeline: Pipeline): GpuPipeline {
    const cached = this.pipelineCache.get(pipeline.id)
    if (cached) return cached

    const shaderModule = this.device.createShaderModule({ code: pipeline.shaderSource })

    let bindGroupLayout: GPUBindGroupLayout | null = null
    if (pipeline.bindings.length > 0) {
      bindGroupLayout = this.device.createBindGroupLayout({
        entries: pipeline.bindings.map((b) => this.pipelineBindingToLayoutEntry(b)),
      })
    }

    const layout = bindGroupLayout
      ? this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] })
      : 'auto'

    const renderPipeline = this.device.createRenderPipeline({
      layout,
      vertex: {
        module: shaderModule,
        entryPoint: pipeline.vertexEntryPoint,
        buffers: pipeline.vertexBufferLayouts.map((vl) => this.toGpuVertexBufferLayout(vl)),
      },
      fragment: {
        module: shaderModule,
        entryPoint: pipeline.fragmentEntryPoint,
        targets: pipeline.colorTargets.map((t) => ({ format: t.format as GPUTextureFormat })),
      },
      primitive: {
        topology: pipeline.topology as GPUPrimitiveTopology,
        cullMode: pipeline.cullMode as GPUCullMode,
      },
      depthStencil: pipeline.depthState
        ? {
            format: pipeline.depthState.format as GPUTextureFormat,
            depthWriteEnabled: pipeline.depthState.depthWriteEnabled,
            depthCompare: pipeline.depthState.depthCompare as GPUCompareFunction,
          }
        : undefined,
    })

    const gpuPipeline: GpuPipeline = {
      pipeline: renderPipeline,
      bindGroupLayout,
      shaderModule,
    }
    this.pipelineCache.set(pipeline.id, gpuPipeline)
    return gpuPipeline
  }

  /** VertexLayout 描述 → GPUVertexBufferLayout */
  private toGpuVertexBufferLayout(vl: VertexLayout): GPUVertexBufferLayout {
    return {
      arrayStride: vl.arrayStride,
      attributes: vl.attributes.map((a) => ({
        shaderLocation: a.shaderLocation,
        offset: a.offset,
        format: a.format as GPUVertexFormat,
      })),
    }
  }

  /* ---------------- Attachment 管理 ---------------- */

  /**
   * 同步 canvas 物理尺寸 + 重建 size='swapchain' 的 attachment。
   * @returns 尺寸是否变化
   */
  resize(width: number, height: number): boolean {
    if (this.currentWidth === width && this.currentHeight === height) return false
    this.currentWidth = width
    this.currentHeight = height
    // 重建所有非 swapchain attachment（其 size='swapchain' 跟随 canvas）
    // 实际重建在 ensureAttachments 中按需做
    return true
  }

  /**
   * 确保图所需的所有 attachment 都已创建（且尺寸匹配当前 canvas）。
   * swapchain 类型跳过（每帧 getCurrentTexture）。
   * attachment 按 graph.id 分桶缓存（不同 graph 同名 attachment 不会复用错误资源）。
   */
  ensureAttachments(graph: PipelineGraph): void {
    for (const att of graph.attachments) {
      if (att.kind === 'swapchain') continue
      this.ensureAttachment(graph, att)
    }
  }

  /** 确保单个 attachment 的 GPU 资源存在且尺寸正确（按 graph 分桶） */
  private ensureAttachment(graph: PipelineGraph, att: Attachment): GpuAttachment {
    const width = att.size.mode === 'swapchain' ? this.currentWidth : att.size.width ?? 1
    const height = att.size.mode === 'swapchain' ? this.currentHeight : att.size.height ?? 1

    let bucket = this.attachmentCache.get(graph.id)
    if (!bucket) {
      bucket = new Map()
      this.attachmentCache.set(graph.id, bucket)
    }

    const cached = bucket.get(att.name)
    if (cached && cached.width === width && cached.height === height) {
      return cached
    }
    if (cached) {
      cached.texture.destroy()
    }

    const isDepth = att.kind === 'depth'
    const format = att.format as GPUTextureFormat
    let usage: GPUTextureUsageFlags
    if (isDepth) {
      usage = GPUTextureUsage.RENDER_ATTACHMENT
    } else {
      // color attachment：作为 RTV 写入 + 可能被后续 pass 采样
      usage = GPUTextureUsage.RENDER_ATTACHMENT | (att.sampledByLaterPass ? GPUTextureUsage.TEXTURE_BINDING : 0)
    }

    const texture = this.device.createTexture({
      size: { width, height },
      format,
      usage,
      sampleCount: 1,
    })
    const gpuAtt: GpuAttachment = {
      texture,
      view: texture.createView(),
      width,
      height,
    }
    bucket.set(att.name, gpuAtt)
    return gpuAtt
  }

  /** 取 attachment 的 GPU 资源（swapchain 类型返回当前帧 swapchain） */
  private getAttachmentView(graph: PipelineGraph, att: Attachment): GPUTextureView {
    if (att.kind === 'swapchain') {
      return this.ctx.getCurrentTexture().createView()
    }
    const bucket = this.attachmentCache.get(graph.id)
    const cached = bucket?.get(att.name)
    if (!cached) throw new Error(`[renderer] attachment "${att.name}" 未创建（先调 ensureAttachments）`)
    return cached.view
  }

  /* ---------------- UniformBuffer 实例管理（per-RO per-pipeline） ---------------- */

  /**
   * 确保 RO 在指定 pipeline 下的 UniformBuffer 实例存在 + 写入最新数据。
   *
   * 流程：
   * 1. 首次调用（懒初始化）：
   *    - 按 pipeline.uniformBufferLayout 算总大小，创建 GPU buffer（256 字节对齐）
   *    - 合并 Material.fields（静态，经 material.pipelineBindings[pipeline.id] 映射）
   *    + RO.fieldValues（可变，经 ro.pipelineBindings[pipeline.id] 映射）
   *    - 写入 values Map（key = shader uniform 名）+ 写入 GPU buffer
   * 2. 后续调用（每帧）：
   *    - 用 RO.fieldValues 经 ro.pipelineBindings[pipeline.id] 映射，更新 values 中可变字段
   *    - 静态字段不动（Material.fields 不变）
   *    - writeBuffer 复写 GPU buffer（按字段 offset 增量写）
   *
   * 缓存：uniformBufferCache[ro.id][pipeline.id] = GpuUniformBufferInstance
   * 生命周期：跟随 RO（transitionGraph 释放旧 graph 时 destroy）
   */
  /**
   * 确保全局 UniformBuffer 存在并按当前 view/projection 矩阵算 viewProjection 写入。
   * 缓存按 pipeline.id 索引（同 pipeline 的全局 buffer 所有 RO 共享）。
   * 每帧重写 viewProjection（viewMatrix/projectionMatrix 变化时）。
   *
   * 设计：Renderer 只持 viewMatrix + projectionMatrix 两个 Float32Array（扁平数据），
   * 不持 Camera 对象 —— Camera 是脚本层业务概念，跨层只传扁平矩阵（见隔离层契约）。
   * 脚本层持 Camera 实例，算出矩阵后调 setView/setProjection 同步进来。
   */
  private ensureGlobalUniformBuffer(
    pipeline: Pipeline,
  ): GpuUniformBufferInstance | null {
    // pipeline 无 global scope 字段 → 不需要全局 buffer
    const globalLayout = pipeline.uniformBufferLayout.filter((f) => (f.scope ?? 'instance') === 'global')
    if (globalLayout.length === 0) return null

    let inst = this.globalUniformBufferCache.get(pipeline.id)
    if (!inst) {
      // 算总大小（取 globalLayout 中最大 offset+size，再 256 对齐）
      let totalSize = 0
      for (const f of globalLayout) {
        totalSize = Math.max(totalSize, f.offset + f.size)
      }
      const alignedSize = this.alignTo256(totalSize)
      const gpuBuffer = this.device.createBuffer({
        size: alignedSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      inst = { gpuBuffer, size: alignedSize, values: new Map() }
      this.globalUniformBufferCache.set(pipeline.id, inst)
    }

    // 每帧按当前 viewMatrix × projectionMatrix 算 viewProjection 写入
    if (this.viewMatrix && this.projectionMatrix) {
      const vpSpec = globalLayout.find((f) => f.name === 'viewProjection')
      if (vpSpec) {
        const vp = this.computeViewProjection(this.viewMatrix, this.projectionMatrix)
        this.device.queue.writeBuffer(inst.gpuBuffer, vpSpec.offset, vp)
        inst.values.set('viewProjection', { offset: vpSpec.offset, data: vp })
      }
    }
    return inst
  }

  /** 按 view × projection 算 viewProjection 矩阵（GPU 相乘用，写入 @binding(0)）。
   *  注意顺序：VP = projection * view（列主序矩阵乘法，projection 在左） */
  private computeViewProjection(view: Float32Array, projection: Float32Array): Float32Array {
    const vp = mat4.create()
    mat4.multiply(vp, projection, view)
    return vp as Float32Array
  }

  /** 从 scene.camera 算初始 view + projection 矩阵（renderGraph 首次调用时）。
   *  type='orthographic' 当前未实现参数，抛错提示后续补。
   *  之后脚本层可调 setView/setProjection 覆盖。 */
  private initMatricesFromSceneCamera(cam: Camera): void {
    const aspect = cam.aspect ?? (this.currentWidth / Math.max(1, this.currentHeight))
    if (cam.type === 'orthographic') {
      throw new Error('[renderer] orthographic camera 暂未实现投影参数（type=orthographic 需补 left/right/top/bottom 或 size 字段）')
    }
    const view = mat4.create()
    mat4.lookAt(view, cam.position, cam.target, cam.up)
    const projection = mat4.create()
    mat4.perspective(projection, cam.fov, aspect, cam.near, cam.far)
    this.viewMatrix = view as Float32Array
    this.projectionMatrix = projection as Float32Array
  }

  /** 同步 view 矩阵（脚本层持 Camera 对象算出后调此方法）。
   *  传入的矩阵会被拷贝（避免外部修改影响内部状态）。下一帧 ensureGlobalUniformBuffer 自动反映。 */
  setView(view: Float32Array): void {
    this.viewMatrix = new Float32Array(view)
  }

  /** 同步 projection 矩阵（脚本层算出后调此方法；如 aspect 变化时重算 perspective）。
   *  传入的矩阵会被拷贝。下一帧 ensureGlobalUniformBuffer 自动反映。 */
  setProjection(projection: Float32Array): void {
    this.projectionMatrix = new Float32Array(projection)
  }

  private ensureUniformBuffer(
    ro: RenderObject,
    pipeline: Pipeline,
  ): GpuUniformBufferInstance | null {
    // pipeline 无 instance scope 字段（如 present pipeline）→ 不需要 per-RO UniformBuffer
    const instanceLayout = pipeline.uniformBufferLayout.filter((f) => (f.scope ?? 'instance') === 'instance')
    if (instanceLayout.length === 0) return null

    // 找/建 RO 的 uniform buffer 桶
    let roBucket = this.uniformBufferCache.get(ro.id)
    if (!roBucket) {
      roBucket = new Map()
      this.uniformBufferCache.set(ro.id, roBucket)
    }

    let inst = roBucket.get(pipeline.id)
    if (!inst) {
      // 首次：创建 GPU buffer + 初始化所有字段（静态 + 可变）
      inst = this.createUniformBufferInstance(ro, pipeline)
      roBucket.set(pipeline.id, inst)
      return inst
    }

    // 后续：只更新可变字段（来自 RO.fieldValues）
    this.updateUniformBufferInstance(inst, ro, pipeline)
    return inst
  }

  /** 创建 per-RO UniformBuffer 实例（首次）：合并静态字段 + 可变字段，写入 GPU buffer。
   *  只处理 scope='instance' 字段（global 字段归 ensureGlobalUniformBuffer） */
  private createUniformBufferInstance(
    ro: RenderObject,
    pipeline: Pipeline,
  ): GpuUniformBufferInstance {
    // 只算 instance scope 字段的总大小
    const instanceLayout = pipeline.uniformBufferLayout.filter((f) => (f.scope ?? 'instance') === 'instance')
    let totalSize = 0
    for (const f of instanceLayout) {
      totalSize = Math.max(totalSize, f.offset + f.size)
    }
    const alignedSize = this.alignTo256(totalSize)

    const gpuBuffer = this.device.createBuffer({
      size: alignedSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // values Map：key = shader uniform 名，value = { offset, data }
    const values = new Map<string, { offset: number; data: Float32Array }>()

    // 写入静态字段（Material.fields → material.pipelineBindings[pipeline.id] → shader uniform 名）
    const materialBindings = ro.material.pipelineBindings[pipeline.id] ?? {}
    for (const [shaderUniformName, materialFieldName] of Object.entries(materialBindings)) {
      const fieldValue = ro.material.fields[materialFieldName]
      if (fieldValue instanceof Float32Array) {
        const spec = instanceLayout.find((f) => f.name === shaderUniformName)
        if (!spec) {
          throw new Error(`[renderer] pipeline "${pipeline.id}" instance uniform "${shaderUniformName}" 未在 uniformBufferLayout 声明`)
        }
        values.set(shaderUniformName, { offset: spec.offset, data: fieldValue })
        this.device.queue.writeBuffer(gpuBuffer, spec.offset, fieldValue)
      } else if (fieldValue !== undefined) {
        // 非 Float32Array 的静态字段（数字/数组等）暂不支持，需要上层转 Float32Array
        console.warn(`[renderer] 静态字段 "${materialFieldName}" 非 Float32Array，跳过（暂不支持）`)
      }
    }

    // 写入可变字段（RO.fieldValues → ro.pipelineBindings[pipeline.id] → shader uniform 名）
    this.updateUniformBufferInstance(
      { gpuBuffer, size: alignedSize, values },
      ro,
      pipeline,
    )

    return { gpuBuffer, size: alignedSize, values }
  }

  /** 更新 per-RO UniformBuffer 实例的可变字段（每帧调）：从 RO.fieldValues 按 pipelineBindings 映射更新。
   *  只处理 scope='instance' 字段（global 字段归 ensureGlobalUniformBuffer） */
  private updateUniformBufferInstance(
    inst: GpuUniformBufferInstance,
    ro: RenderObject,
    pipeline: Pipeline,
  ): void {
    const instanceLayout = pipeline.uniformBufferLayout.filter((f) => (f.scope ?? 'instance') === 'instance')
    const roBindings = ro.pipelineBindings[pipeline.id] ?? {}
    for (const [shaderUniformName, roFieldName] of Object.entries(roBindings)) {
      const data = ro.fieldValues.get(roFieldName)
      if (!data) continue  // 该字段无数据（可能未提供）
      const spec = instanceLayout.find((f) => f.name === shaderUniformName)
      if (!spec) {
        throw new Error(`[renderer] pipeline "${pipeline.id}" instance uniform "${shaderUniformName}" 未在 uniformBufferLayout 声明`)
      }
      const existing = inst.values.get(shaderUniformName)
      if (existing && existing.data === data) {
        // 引用相等：数据未变，跳过 writeBuffer（避免重复写入）
        continue
      }
      inst.values.set(shaderUniformName, { offset: spec.offset, data })
      this.device.queue.writeBuffer(inst.gpuBuffer, spec.offset, data)
    }
  }

  /** 256 字节对齐（WebGPU uniform buffer offset/size 要求） */
  private alignTo256(n: number): number {
    return Math.ceil(n / 256) * 256
  }

  /** 默认 sampler（用于 sampled-texture 配对；按需创建并缓存） */
  private defaultSampler: GPUSampler | null = null
  private getDefaultSampler(): GPUSampler {
    if (!this.defaultSampler) {
      this.defaultSampler = this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
      })
    }
    return this.defaultSampler
  }

  /* ---------------- 渲染 PipelineGraph ---------------- */

  /**
   * 渲染整个 Scene：按 graph 节点顺序遍历，每节点一个 render pass。
   *
   * 帧时序：
   * 1. ensureAttachments（按当前 canvas 尺寸创建/重建离屏 attachment）
   * 2. 一个 encoder 含所有节点 pass
   * 3. 每节点：beginRenderPass(colorAttachments + depthStencil) → setPipeline →
   *    筛选 scene.renderObjects 中 material.pipelineBindings 含 node.pipeline.id 的 RO →
   *    对每个 RO：setBindGroup(uniforms) + setVertexBuffer + setIndexBuffer + drawIndexed
   * 4. submit 一次
   *
   * RO 与 pass 关联规则：
   * - RO 不显式声明 passName，靠 material.pipelineBindings 的 key 集合声明在哪些 pipeline 可见
   * - Renderer 渲染 node 时按 `node.pipeline.id ∈ ro.material.pipelineBindings 的 key` 筛选 RO
   * - 这与材质三段式 pipelineBindings 对称（材质静态字段映射 + RO 可变字段映射共用同一 key 空间）
   *
   * 边（attachment 流动）的处理：
   * - 节点的 colorAttachmentInputs 在 pipeline.bindings 中声明为 sampled-texture
   * - Renderer 在 setBindGroup 时把对应 attachment 的 view 作为 binding 资源
   * - 这要求 edge.toBinding 与 pipeline.bindings 中的 binding 编号一致
   */
  renderGraph(graph: PipelineGraph, scene?: Scene): void {
    // graph 引用变化 → 触发场景切换 diff（释放旧 graph 的运行时资源 + 按 id diff 资产缓存）
    if (this.activeGraph !== graph) {
      if (this.activeGraph) {
        this.transitionGraph(this.activeGraph, graph, this.activeScene ?? undefined, scene)
      }
      this.activeGraph = graph
      this.activeScene = scene ?? null
      // 场景切换时从 scene.camera 算初始 view + projection 矩阵
      // （之后脚本层可调 setView/setProjection 覆盖；Renderer 不持 Camera 对象）
      if (scene?.camera) {
        this.initMatricesFromSceneCamera(scene.camera)
      } else {
        this.viewMatrix = null
        this.projectionMatrix = null
      }
    } else if (scene && this.activeScene !== scene) {
      // 同一 graph 但 scene 引用变化（如切换 scene 实例）：更新 activeScene + 重算初始矩阵
      this.activeScene = scene
      if (scene.camera) {
        this.initMatricesFromSceneCamera(scene.camera)
      } else {
        this.viewMatrix = null
        this.projectionMatrix = null
      }
    }

    this.ensureAttachments(graph)

    const encoder = this.device.createCommandEncoder()

    // 预构建 edge 索引：to 节点名 + binding 编号 → from attachment 名
    const edgeIndex = new Map<string, { attachment: string }>()
    for (const edge of graph.edges) {
      edgeIndex.set(`${edge.to}::${edge.toBinding}`, { attachment: edge.attachment })
    }

    for (const node of graph.nodes) {
      // 筛选 scene 中 material.pipelineBindings 含 node.pipeline.id 的 RO
      // （RO 通过材质声明自己在哪些 pipeline 可见；不显式绑定 passName）
      const visibleRos = scene
        ? scene.renderObjects.filter((ro) =>
            Object.prototype.hasOwnProperty.call(ro.material.pipelineBindings, node.pipeline.id),
          )
        : []
      this.renderNode(node, encoder, edgeIndex, graph, visibleRos)
    }

    this.device.queue.submit([encoder.finish()])
  }

  /**
   * 场景切换：从 oldGraph 切到 newGraph。
   *
   * 资产缓存（model/pipeline）按 id 做 set diff 保留：
   * - keep = old ∩ new（GPU 资源保留，自然命中缓存）
   * - release = old - new（destroy GPU 资源，从缓存移除）
   * - create = new - old（下次 compile 按需创建，不主动）
   * （Material 不再有 GPU 资源，不参与 diff；它是纯数据，跨场景引用稳定即可）
   *
   * 运行时缓存（UniformBuffer/attachment）跟随 graph 一刀切释放：
   * - 旧 graph 的 UniformBuffer 实例全部 destroy（per-RO per-pipeline）
   * - 旧 graph 的 attachment bucket 全部 destroy
   */
  private transitionGraph(
    oldGraph: PipelineGraph,
    newGraph: PipelineGraph,
    oldScene?: Scene,
    newScene?: Scene,
  ): void {
    const newAssetIds = this.collectAssetIds(newGraph, newScene)
    const oldAssetIds = this.collectAssetIds(oldGraph, oldScene)

    // release = old - new（destroy + 移除）
    this.releaseAssets(oldAssetIds, newAssetIds)

    // 旧 graph 的 UniformBuffer 实例一刀切释放（per-RO per-pipeline）
    for (const ro of this.iterRenderObjects(oldScene)) {
      const roBucket = this.uniformBufferCache.get(ro.id)
      if (roBucket) {
        for (const inst of roBucket.values()) {
          inst.gpuBuffer.destroy()
        }
        this.uniformBufferCache.delete(ro.id)
      }
    }

    // 旧 graph 的全局 UniformBuffer 一刀切释放（per-pipeline，所有 RO 共享）
    // 按 pipeline.id 索引：旧 graph 的 pipeline 不在新 graph 中时释放对应 global buffer
    const newPipelineIds = new Set(newGraph.nodes.map((n) => n.pipeline.id))
    for (const node of oldGraph.nodes) {
      const pid = node.pipeline.id
      if (!newPipelineIds.has(pid)) {
        const inst = this.globalUniformBufferCache.get(pid)
        if (inst) {
          inst.gpuBuffer.destroy()
          this.globalUniformBufferCache.delete(pid)
        }
      }
    }

    // 旧 graph 的 attachment bucket 一刀切释放
    const oldBucket = this.attachmentCache.get(oldGraph.id)
    if (oldBucket) {
      for (const att of oldBucket.values()) {
        att.texture.destroy()
      }
      this.attachmentCache.delete(oldGraph.id)
    }
  }

  /** 收集 graph + scene 引用的所有资产 id（model/pipeline；Material 不再有 GPU 资源） */
  private collectAssetIds(graph: PipelineGraph, scene?: Scene): {
    models: Set<string>
    pipelines: Set<string>
  } {
    const models = new Set<string>()
    const pipelines = new Set<string>()
    for (const node of graph.nodes) {
      pipelines.add(node.pipeline.id)
    }
    if (scene) {
      for (const ro of scene.renderObjects) {
        models.add(ro.model.id)
      }
    }
    return { models, pipelines }
  }

  /** 释放 oldAssets - newAssets 对应的 GPU 资源（按 id diff） */
  private releaseAssets(
    oldAssets: { models: Set<string>; pipelines: Set<string> },
    newAssets: { models: Set<string>; pipelines: Set<string> },
  ): void {
    for (const id of oldAssets.models) {
      if (!newAssets.models.has(id)) {
        const m = this.modelCache.get(id)
        if (m) {
          m.vertexBuffer?.destroy()
          m.indexBuffer?.destroy()
          this.modelCache.delete(id)
        }
      }
    }
    for (const id of oldAssets.pipelines) {
      if (!newAssets.pipelines.has(id)) {
        // GPURenderPipeline/shaderModule/bindGroupLayout 由 device 销毁时释放（不显式 destroy）
        this.pipelineCache.delete(id)
      }
    }
  }

  /** 遍历 scene 中所有 RenderObject（用于 uniform 释放） */
  private *iterRenderObjects(scene?: Scene): Generator<RenderObject> {
    if (scene) {
      for (const ro of scene.renderObjects) {
        yield ro
      }
    }
  }

  /** 渲染单个节点（一个 render pass） */
  private renderNode(
    node: PipelineNode,
    encoder: GPUCommandEncoder,
    edgeIndex: Map<string, { attachment: string }>,
    graph: PipelineGraph,
    renderObjects: RenderObject[],
  ): void {
    const gpuPipeline = this.compilePipeline(node.pipeline)

    // 构造 colorAttachments：每个输出 attachment 一项
    const colorAttachments: GPURenderPassColorAttachment[] = []
    for (const outName of node.colorAttachmentOutputs) {
      const att = graph.attachments.find((a) => a.name === outName)
      if (!att) throw new Error(`[renderer] 节点 "${node.name}" 输出 attachment "${outName}" 未在 graph.attachments 声明`)
      colorAttachments.push({
        view: this.getAttachmentView(graph, att),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      })
    }

    // depthStencil（可选）
    let depthStencil: GPURenderPassDepthStencilAttachment | undefined
    if (node.depthAttachment) {
      const att = graph.attachments.find((a) => a.name === node.depthAttachment)
      if (!att) throw new Error(`[renderer] 节点 "${node.name}" 深度 attachment "${node.depthAttachment}" 未声明`)
      depthStencil = {
        view: this.getAttachmentView(graph, att),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      }
    }

    const pass = encoder.beginRenderPass({
      colorAttachments,
      depthStencilAttachment: depthStencil,
    })
    pass.setPipeline(gpuPipeline.pipeline)

    // 全局 UniformBuffer（scope='global'，如 viewProjection）：同 pass 所有 RO 共享，
    // 在 RO 循环外创建一次。每帧按 scene.camera 算 VP 写入。
    const globalUniformBuffer = this.ensureGlobalUniformBuffer(node.pipeline)

    // 对每个 RenderObject：构建 bindGroup（合并 UniformBuffer + edge texture + sampler）+ setVertexBuffer + drawIndexed
    for (const ro of renderObjects) {
      const gpuModel = this.compileModel(ro.model)

      // 收集所有 binding 资源（uniform-buffer + sampled-texture + sampler）到一个 bindGroup（@group(0)）
      if (gpuPipeline.bindGroupLayout) {
        // 确保 per-RO UniformBuffer 实例存在 + 写入最新可变字段（scope='instance'，如 modelMatrix）
        const instanceUniformBuffer = this.ensureUniformBuffer(ro, node.pipeline)
        const entries: GPUBindGroupEntry[] = []
        for (const b of node.pipeline.bindings) {
          if (b.kind === 'uniform-buffer') {
            const scope = b.scope ?? 'instance'
            if (scope === 'global') {
              if (!globalUniformBuffer) {
                throw new Error(`[renderer] 节点 "${node.name}" pipeline "${node.pipeline.id}" 声明 global uniform binding ${b.binding} 但无 global uniformBufferLayout`)
              }
              entries.push({ binding: b.binding, resource: { buffer: globalUniformBuffer.gpuBuffer } })
            } else {
              if (!instanceUniformBuffer) {
                throw new Error(`[renderer] 节点 "${node.name}" pipeline "${node.pipeline.id}" 声明 instance uniform binding ${b.binding} 但 uniformBufferLayout 为空`)
              }
              entries.push({ binding: b.binding, resource: { buffer: instanceUniformBuffer.gpuBuffer } })
            }
          } else if (b.kind === 'sampled-texture') {
            // 边输入：从 edgeIndex 找到对应的 from attachment
            const edgeKey = `${node.name}::${b.binding}`
            const edge = edgeIndex.get(edgeKey)
            if (!edge) throw new Error(`[renderer] 节点 "${node.name}" sampled-texture binding ${b.binding} 无对应 edge`)
            const att = graph.attachments.find((a) => a.name === edge.attachment)
            if (!att) throw new Error(`[renderer] edge attachment "${edge.attachment}" 未声明`)
            entries.push({ binding: b.binding, resource: this.getAttachmentView(graph, att) })
          } else if (b.kind === 'sampler') {
            entries.push({ binding: b.binding, resource: this.getDefaultSampler() })
          }
        }
        const bg = this.device.createBindGroup({
          layout: gpuPipeline.bindGroupLayout,
          entries,
        })
        pass.setBindGroup(0, bg)
      }

      // setVertexBuffer（按 vertexBufferLayouts 的 slot 序；目前仅支持 slot 0）
      if (node.pipeline.vertexBufferLayouts.length > 0 && gpuModel.vertexBuffer) {
        pass.setVertexBuffer(0, gpuModel.vertexBuffer)
      }

      // setIndexBuffer + drawIndexed（或 draw）
      if (gpuModel.indexBuffer && gpuModel.indexCount > 0) {
        pass.setIndexBuffer(gpuModel.indexBuffer, 'uint16')
        pass.drawIndexed(gpuModel.indexCount)
      } else if (gpuModel.vertexBuffer && node.pipeline.vertexBufferLayouts.length > 0) {
        // 无索引但有 vertex buffer：按 arrayStride 推算顶点数
        const stride = node.pipeline.vertexBufferLayouts[0].arrayStride || 4
        pass.draw(gpuModel.vertexBuffer.size / stride)
      } else {
        // 无 vertex buffer（全屏三角形）：3 顶点
        pass.draw(3)
      }
    }

    pass.end()
  }

  /* ---------------- 资源释放 ---------------- */

  /** 销毁所有缓存的 GPU 资源（窗口关闭/unload 时调） */
  dispose(): void {
    for (const m of this.modelCache.values()) {
      m.vertexBuffer?.destroy()
      m.indexBuffer?.destroy()
    }
    this.modelCache.clear()

    // attachment 按 graph 分桶，逐桶释放
    for (const bucket of this.attachmentCache.values()) {
      for (const att of bucket.values()) {
        att.texture.destroy()
      }
    }
    this.attachmentCache.clear()

    // uniformBufferCache：per-RO per-pipeline 二层 Map
    for (const roBucket of this.uniformBufferCache.values()) {
      for (const inst of roBucket.values()) {
        inst.gpuBuffer.destroy()
      }
    }
    this.uniformBufferCache.clear()

    // globalUniformBufferCache：per-pipeline 全局 uniform buffer（所有 RO 共享）
    for (const inst of this.globalUniformBufferCache.values()) {
      inst.gpuBuffer.destroy()
    }
    this.globalUniformBufferCache.clear()

    // viewMatrix/projectionMatrix：仅持有 Float32Array 引用，无 GPU 资源，置 null 即可
    this.viewMatrix = null
    this.projectionMatrix = null
    this.activeGraph = null
    this.activeScene = null

    // pipeline/shaderModule 由 device 销毁时自动释放（不显式 destroy）
    this.pipelineCache.clear()
  }
}
