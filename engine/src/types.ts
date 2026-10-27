/**
 * 引擎业务层核心数据描述对象（与 WebGPU 解耦）。
 *
 * 设计原则（见 docs/design/engine-layer.md 反向沉淀路径）：
 * - 数据描述型：每个对象只存描述数据，不持有 GPU 资源
 * - GPU 资源由 Renderer（engine/src/webgpu/Renderer.ts）创建/缓存/管理
 * - 对象与 WebGPU 解耦，未来切换 native（Vulkan）后端时只需新写 NativeRenderer
 *
 * 五个对象职责边界：
 * - Model：几何数据（顶点+索引+顶点布局）
 * - Material：着色器+binding 描述（当前只有顶点色 shader + 0 binding）
 * - Pipeline：渲染状态（顶点/片元入口+图元/深度/剔除+目标格式）
 * - RenderObject：场景实例（Model + Material + uniform 参数如 mvp）
 * - PipelineGraph：节点+边 DAG（节点=Pipeline+输入输出 attachment，边=attachment 流动）
 *
 * ---------------- 引擎/脚本通讯边界（关键架构约束） ----------------
 *
 * 未来引擎主体不是 JS（native 后端），脚本与引擎之间有天然隔离层：
 * - 双方通讯只能用**可序列化的扁平数据**（id / Handle / 值类型），不能传对象引用
 * - 脚本不直接持有描述对象，只持 Handle（含内部 id 的扁平包装）
 * - 脚本调 API 传 Handle，引擎按 id 查描述对象 → 查/建 GPU 资源
 * - 当前 demo 阶段引擎在 JS 内（直接传引用）是过渡形态，未来切换 native 时
 *   所有 API 入参从"对象引用"改为"Handle"，本文件类型定义保持不变
 *
 * ---------------- 两类 id + 资产/运行时二分 ----------------
 *
 * 对象分两类，每类有不同形式的 id，决定 Renderer 缓存生命周期策略：
 *
 * 1. 持久化资产（Model / Material / Pipeline）：
 *    - 外部稳定 id：`<namespace>:<path>`（如 `mesh:cube.fbx`、`mat:pbr/base`）
 *    - 代码可硬编码（脚本可传字符串 id 加载资产）
 *    - 由资产加载器从磁盘加载（未来 .scene / Asset 协议）
 *    - 跨场景复用：同一 id = 同一 GPU 资源（Renderer 按 id diff 保留）
 *    - 加载器必须按 id 去重，同一资产不重复 new 描述对象
 *
 * 2. 运行时对象（RenderObject / PipelineGraph 内的 attachment）：
 *    - 内部 id：引擎运行时生成（自增/UUID），仅用于比较/打印/去重/Handle 标识
 *    - 代码不可硬编码（脚本拿不到具体值，只能持 Handle）
 *    - 由脚本运行时通过 API 创建/销毁（Handle 接收后标识"这个 Handle 是这个 RenderObject"）
 *    - 跟随场景生命周期：场景切换时整体释放，不跨场景复用
 *
 * ---------------- 缓存生命周期契约 ----------------
 *
 * 1. 持久化资产缓存（modelCache / materialCache / pipelineCache）：
 *    - key = 资产 id（当前 demo 用引用相等是过渡，未来切 native 改 id）
 *    - 场景切换 A→B 时按 id 集合做 set diff：
 *      keep = A∩B（GPU 资源保留）；release = A-B（destroy）；create = B-A（按需）
 *
 * 2. 运行时对象缓存（uniformCache / attachmentCache）：
 *    - key = 运行时对象内部 id（当前 demo 用引用相等是过渡）
 *    - 跟随场景一刀切释放，不参与 diff
 *
 * 3. swapchain 永远跟随 Renderer（不归属任何场景）。
 *
 * 关键契约：描述对象一旦提交给 Renderer 即不可变（id 相等 → 内容相等）。
 *           违反此契约会导致缓存命中但 GPU 资源数据陈旧。
 *           需要修改资产时，新建描述对象（新 id），让缓存自然 diff/释放旧资源。
 *
 * 当前实现（demo 阶段）：5 个 Map 平铺，key 用引用相等，仅 dispose() 全清，
 *   无场景切换 diff。未来切换 native + 多场景时：
 *   - key 从引用改为 id（资产 id / 运行时内部 id）
 *   - 5 个 Map 改为 Map<PipelineGraph, Bucket>
 *   - 加 transitionGraph(old,new) 实现 id diff
 *   详见 memory: experience_architecture_gpu-cache-lifecycle。
 */

/* ---------------- 顶点布局 ---------------- */

/** 顶点属性格式（与 WebGPU GPUVertexFormat 对齐，但作为纯字符串描述） */
export type VertexAttributeFormat =
  | 'float32x2'
  | 'float32x3'
  | 'float32x4'

/** 单个顶点属性描述（如 position @0 vec3, color @1 vec3） */
export interface VertexAttribute {
  /** shader 中的 @location(N) */
  shaderLocation: number
  /** 在顶点结构内的字节偏移 */
  offset: number
  format: VertexAttributeFormat
}

/** 顶点 buffer 布局（一个 Model 可有多个，目前立方体只用 1 个） */
export interface VertexLayout {
  /** 单顶点字节步长 */
  arrayStride: number
  /** 顶点属性列表 */
  attributes: VertexAttribute[]
}

/* ---------------- Model（几何数据） ---------------- */

/**
 * Model：几何数据描述。
 *
 * 字段：
 * - vertices：顶点 buffer 原始字节（Float32Array 序列化）
 * - indices：索引 buffer（Uint16Array 序列化；可选，无索引时 undefined 用 draw）
 * - vertexLayouts：顶点 buffer 布局列表（对应 setVertexBuffer(slot, buffer) 的 slot 序）
 *
 * 不含：材质/纹理/着色器（这些归 Material/Pipeline）
 * 不含：mvp 等实例参数（这些归 RenderObject）
 */
export interface Model {
  /**
   * 持久化资产外部 id：`<namespace>:<path>`（如 'mesh:cube.fbx'）。
   * 跨场景稳定，代码可硬编码。Renderer 按此 id 缓存 + 场景切换 diff 保留。
   * 加载器必须按 id 去重，同一 id 不重复 new Model。
   */
  id: string
  vertices: Float32Array
  indices?: Uint16Array
  vertexLayouts: VertexLayout[]
}

/* ---------------- Material（材质：静态字段 + 管线映射） ---------------- */

/**
 * Material：材质资产 = 静态字段数据 + 字段到各 pipeline shader uniform 的映射。
 *
 * 设计原则（见 docs/design/engine-layer.md + memory: experience_architecture_gpu-cache-lifecycle）：
 * - Material 是静态资产（有外部 id，跨场景 diff 保留；fields 不变，写入 UniformBuffer 一次）
 * - Material 不绑 pipeline：通过 pipelineBindings 适配多个 pipeline 的 shader uniform 命名差异
 * - Material 不持 shader：shader 归 Pipeline；Material 只管数据 + 映射
 *
 * 数据信息三段式（metadata / fields / pipelineBindings）：
 * - metadata：Schema 定义（IDE SchemaForm 渲染材质编辑页面），规定 fields 的数据结构和类型
 * - fields：按 metadata Schema 填充的静态字段值（如基础色、粗糙度）
 * - pipelineBindings：字段 → 各 pipeline shader uniform 的映射表（二层字典）
 */
export interface Material {
  /**
   * 持久化资产外部 id：`<namespace>:<path>`（如 'mat:pbr/base'）。
   * 跨场景稳定，代码可硬编码。Renderer 按此 id 缓存 + 场景切换 diff 保留。
   */
  id: string
  /** 通用展示名（IDE 显示用） */
  name: string
  /**
   * Schema 定义（配合 IDE SchemaForm 渲染材质编辑页面）。
   * 规定 fields 的数据结构和类型。具体结构由 Schema 协议定义（当前 demo 阶段可为空对象）。
   */
  metadata: MaterialSchema
  /**
   * 静态字段值（按 metadata Schema 填充）。
   * key = 字段语义名（稳定，如 'baseColor'、'roughness'）
   * value = 字段值（类型由 Schema 约束，运行时为 Float32Array / 数字 / 数组等）
   * 静态语义：材质定义时确定，运行时不变；映射到 UniformBuffer 后只写一次。
   */
  fields: Record<string, unknown>
  /**
   * 管线映射字典（二层 kv）。
   * 第一层 key = pipeline id 字符串（如 'pipeline:cube-opaque'）
   * 第一层 value = uniform 名映射：
   *   key = 当前 pipeline shader 中的 uniform 名（如 'mvp'、'baseColorUniform'）
   *   value = Material.fields 中的字段名（如 'modelViewProj'、'baseColor'）
   *
   * 作用：材质字段在不同 pipeline shader 里可能叫不同名字，靠此映射表翻译。
   * 同一材质可适配多个 pipeline（不同 shader 用不同 uniform 名）。
   */
  pipelineBindings: Record<string, Record<string, string>>
}

/**
 * Material Schema 定义（配合 IDE SchemaForm 渲染材质编辑页面）。
 *
 * 规定 Material.fields 的数据结构和类型。具体结构由 Schema 协议定义。
 * 当前 demo 阶段为空对象（顶点色材质无静态字段）；未来 PBR 材质会有 baseColor/roughness/metallic 等字段定义。
 */
export type MaterialSchema = Record<string, unknown>

/* ---------------- Pipeline（渲染状态 + shader + binding 结构） ---------------- */

/** 图元拓扑 */
export type PrimitiveTopology = 'triangle-list' | 'line-list' | 'point-list'

/** 背面剔除模式 */
export type CullMode = 'none' | 'back' | 'front'

/** 深度比较函数 */
export type DepthCompare = 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always'

/** 深度状态描述 */
export interface DepthState {
  format: string
  depthWriteEnabled: boolean
  depthCompare: DepthCompare
}

/** 颜色目标描述（一个 pipeline 可有多个 MRT，立方体只用 1 个） */
export interface ColorTargetDesc {
  /** 输出纹理 format（如 'rgba8unorm' / swapchain format） */
  format: string
}

/**
 * Pipeline binding 类型（与 WebGPU BindGroupLayoutEntry 对齐但简化）。
 * - 'uniform-buffer'：UBO（如 mvp 矩阵，由 UniformBuffer 提供）
 * - 'sampled-texture'：采样纹理（attachment 边输入或外部纹理）
 * - 'sampler'：采样器
 */
export type PipelineBindingKind = 'uniform-buffer' | 'sampled-texture' | 'sampler'

/**
 * Pipeline binding 描述：声明 pipeline shader 需要哪些 binding。
 * 归 Pipeline 声明（pipeline 知道自己 shader 的 binding 结构）。
 */
export interface PipelineBinding {
  /** @group(0)@binding(N) 的 N */
  binding: number
  /** binding 类型 */
  kind: PipelineBindingKind
  /** visibility：'vertex' | 'fragment' | 'vertex+fragment' */
  visibility: 'vertex' | 'fragment' | 'vertex+fragment'
  /** uniform-buffer 时的字节大小（用于创建 buffer；与 uniformBufferLayout 总大小一致） */
  bufferSize?: number
  /** sampled-texture 时的 format（用于 layout 描述） */
  textureFormat?: string
}

/**
 * Pipeline 的 uniform 字段定义（描述 shader uniform buffer 的内存布局）。
 * 用于 UniformBuffer 创建 + 字段 offset 计算 + 数据写入定位。
 */
export interface UniformFieldSpec {
  /** shader 中的 uniform 名（如 'mvp'、'baseColor'） */
  name: string
  /** 字段类型（与 WebGPU GPUVertexFormat 对齐但简化） */
  type: 'float32' | 'float32x2' | 'float32x3' | 'float32x4' | 'float32x4x4'
  /** 在 uniform buffer 内的字节偏移（按 16 字节对齐，WebGPU uniform buffer 规范） */
  offset: number
  /** 字段字节大小（type 对应的字节数） */
  size: number
}

/**
 * Pipeline：渲染状态 + shader + binding 结构。
 *
 * 字段：
 * - shaderSource + vertexEntryPoint + fragmentEntryPoint：WGSL 源码（shader 归 Pipeline）
 * - bindings：binding layout 声明（uniform-buffer / sampled-texture / sampler；归 Pipeline）
 * - uniformBufferLayout：uniform 字段内存布局（用于 UniformBuffer 创建 + 字段写入定位）
 * - primitive/topology/cullMode：图元状态
 * - depthState：深度测试状态（可选，无则不启用深度）
 * - colorTargets：颜色目标格式列表（必须与 render pass attachment 匹配）
 * - vertexBufferLayouts：顶点 buffer 布局
 *
 * 不含：Material 引用（Material 挂在 RenderObject 上，不绑 Pipeline）
 * 不含：实际 GPURenderPipeline（由 Renderer 缓存创建）
 */
export interface Pipeline {
  /**
   * 持久化资产外部 id：`<namespace>:<path>`（如 'pipeline:cube-opaque'）。
   * 跨场景稳定，代码可硬编码。Renderer 按此 id 缓存 + 场景切换 diff 保留。
   */
  id: string
  /** WGSL 源码字符串 */
  shaderSource: string
  /** 顶点着色器入口名 */
  vertexEntryPoint: string
  /** 片元着色器入口名 */
  fragmentEntryPoint: string
  /** binding 列表（声明 pipeline shader 需要哪些 binding） */
  bindings: PipelineBinding[]
  /** uniform 字段内存布局（用于 UniformBuffer 创建 + 字段写入定位） */
  uniformBufferLayout: UniformFieldSpec[]
  /** 图元拓扑（默认 'triangle-list'） */
  topology: PrimitiveTopology
  /** 背面剔除（默认 'none'） */
  cullMode: CullMode
  /** 深度状态（可选） */
  depthState?: DepthState
  /** 颜色目标格式列表 */
  colorTargets: ColorTargetDesc[]
  /**
   * 顶点 buffer 布局列表（对应 setVertexBuffer(slot, buffer) 的 slot 序）。
   * 空数组表示无 vertex buffer（如全屏三角形用 @builtin(vertex_index) 内嵌生成顶点）。
   */
  vertexBufferLayouts: VertexLayout[]
}

/* ---------------- Attachment（管线图中的纹理资源） ---------------- */

/** Attachment 尺寸描述（相对或绝对） */
export interface AttachmentSize {
  /** 'swapchain' = 跟随 swapchain；'fixed' = 固定像素 */
  mode: 'swapchain' | 'fixed'
  /** mode='fixed' 时的像素尺寸 */
  width?: number
  height?: number
}

/**
 * Attachment：管线图中流动的纹理资源描述。
 *
 * 类型：
 * - 'color'：颜色纹理（rgba8unorm 等）
 * - 'depth'：深度纹理（depth24plus 等）
 * - 'swapchain'：当前帧 swapchain（每帧 getCurrentTexture，不创建）
 *
 * 不含：实际 GPUTexture（由 Renderer 在尺寸确定后创建；swapchain 类型每帧取）
 */
export interface Attachment {
  /** 唯一名（图中边按名匹配） */
  name: string
  /** attachment 类型 */
  kind: 'color' | 'depth' | 'swapchain'
  /** 纹理 format（color/depth 用；swapchain 用主设备 preferred format） */
  format: string
  /** 尺寸描述（swapchain 类型忽略，跟随 canvas） */
  size: AttachmentSize
  /** 是否作为纹理被后续 pass 采样（影响 usage 是否加 TEXTURE_BINDING） */
  sampledByLaterPass: boolean
}

/* ---------------- RenderObject（场景实例） ---------------- */

/**
 * RenderObject：场景中的一次绘制实例。
 *
 * 字段：
 * - model：引用 Model 描述（几何）
 * - material：引用 Material 描述（静态字段 + 管线映射）
 * - fieldValues：可变字段值（每帧更新，如 mvp 矩阵）
 * - pipelineBindings：可变字段 → 各 pipeline shader uniform 的映射表（与 Material.pipelineBindings 对称）
 *
 * 渲染侧 UniformBuffer（每个 pipeline 一份，持续存在）由 Renderer 内部缓存管理：
 * - 逻辑上挂在 RenderObject 上（生命周期跟随 RO，RO 释放时一起 destroy）
 * - 物理上不放本接口（本接口是数据描述，可序列化跨 native，不持 GPU 资源引用）
 * - Renderer 内部：Map<RenderObject id, Map<pipeline id, UniformBufferInstance>>
 *
 * 一个 RenderObject = 一次 drawIndexed 调用（在被某 pipeline 渲染时）
 *
 * 渲染流程：
 * 1. RO 首次被某 pipeline 渲染时（懒初始化）：
 *    - 创建 GPU buffer（按 pipeline.uniformBufferLayout 总大小）
 *    - 合并写入：material.fields（静态，经 material.pipelineBindings[pipeline.id] 映射）
 *             + ro.fieldValues（可变，经 ro.pipelineBindings[pipeline.id] 映射）
 *    - 缓存到 Renderer 内部 Map<RO id, Map<pipeline id, UniformBufferInstance>>
 * 2. 每帧渲染时：
 *    - 用 ro.fieldValues 经 ro.pipelineBindings[pipeline.id] 映射，更新 UniformBuffer 中可变字段
 *    - 静态字段不动（material.fields 不变，写入一次后保持）
 *    - writeBuffer 复写 GPU buffer → setBindGroup → drawIndexed
 */
export interface RenderObject {
  /**
   * 运行时对象内部 id：引擎运行时生成（自增），仅用于比较/打印/去重/Handle 标识。
   * 代码不可硬编码（脚本拿不到具体值，只能持 Handle 接收）。
   * Renderer 按此 id 缓存 UniformBuffer；跟随场景一刀切释放，不跨场景复用。
   */
  id: number
  /** 几何模型 */
  model: Model
  /** 材质（静态字段 + 管线映射） */
  material: Material
  /**
   * 可变字段值（用户侧每帧更新）。
   * key = 字段语义名（与 Material.fields 同一命名空间，如 'modelViewProj'）
   * value = 字段值（Float32Array 等）
   */
  fieldValues: Map<string, Float32Array>
  /**
   * 管线映射字典（与 Material.pipelineBindings 对称）。
   * 第一层 key = pipeline id 字符串
   * 第一层 value = uniform 名映射：
   *   key = 当前 pipeline shader 中的 uniform 名
   *   value = RenderObject.fieldValues 中的字段名
   *
   * 作用：RO 的可变字段在不同 pipeline shader 里可能叫不同名字，靠此映射表翻译。
   * 同一 RO 可被多个 pipeline 渲染（如 opaque + wireframe）。
   */
  pipelineBindings: Record<string, Record<string, string>>
}

/* ---------------- PipelineGraph（节点+边 DAG） ---------------- */

/**
 * PipelineNode：管线图中的一个节点 = 一个 render pass。
 *
 * 字段：
 * - name：节点名（如 'cube-pass' / 'present-pass'）
 * - pipeline：本节点用的 Pipeline 描述
 * - renderObjects：本节点绘制的 RenderObject 列表
 * - colorAttachmentInputs：作为输入的颜色 attachment 名（来自前面的 pass 输出或外部）
 * - colorAttachmentOutputs：本 pass 输出的颜色 attachment 名（被后面的 pass 输入或最终输出）
 * - depthAttachment：本 pass 用的深度 attachment 名（可选）
 *
 * 关键：输入 attachment 是"读取前面 pass 输出"的语义；输出 attachment 是"写入"语义。
 * 一个 attachment 由某 pass 输出，由后续 pass 输入（作为纹理采样）—— 这就是 DAG 的边。
 */
export interface PipelineNode {
  name: string
  pipeline: Pipeline
  renderObjects: RenderObject[]
  /** 输入 attachment 名（作为采样纹理；最终 pass 通常输入前面的 color attachment） */
  colorAttachmentInputs: string[]
  /** 输出 attachment 名（作为 RTV 写入） */
  colorAttachmentOutputs: string[]
  /** 深度 attachment 名（可选） */
  depthAttachment?: string
}

/**
 * AttachmentEdge：DAG 的边 = attachment 在节点间的流动。
 *
 * 描述：from 节点输出 → to 节点作为采样输入
 * 实际数据流：from 节点写 colorAttachment，to 节点 setBindGroup 时绑定其 view 采样
 */
export interface AttachmentEdge {
  /** 流动的 attachment 名 */
  attachment: string
  /** 源节点名 */
  from: string
  /** 目标节点名 */
  to: string
  /** 在 to 节点 material bindings 中的 binding 编号 */
  toBinding: number
}

/**
 * PipelineGraph：完整渲染管线图 = 节点 + 边 + 全局 attachment 声明。
 *
 * 拓扑序由 Renderer 按 from/to 依赖计算（或外部直接给定有序节点列表）。
 *
 * 当前 demo：两节点线性图
 *   cube-pass（pipeline: 立方体+深度, 输出: offscreen-color, depth: offscreen-depth）
 *     ↓ edge: offscreen-color → present-pass @binding(0)
 *   present-pass（pipeline: 全屏三角形采样, 输出: swapchain）
 */
export interface PipelineGraph {
  /**
   * 运行时对象内部 id：引擎运行时生成（自增），仅用于比较/打印/标识。
   * 代码不可硬编码。Renderer 按此 id 分桶缓存 attachment（解决不同 graph 同名 attachment 复用错误）。
   * 跟随场景一刀切释放，不跨场景复用。
   */
  id: number
  /** 节点列表（Renderer 按依赖序遍历） */
  nodes: PipelineNode[]
  /** 边列表（attachment 流动） */
  edges: AttachmentEdge[]
  /** 全局 attachment 声明（含 swapchain 类型的外部 attachment） */
  attachments: Attachment[]
}
