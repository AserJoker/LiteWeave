/**
 * 立方体 demo：用对象 API（Model/Material/Pipeline/RenderObject/PipelineGraph）描述立方体场景。
 *
 * 场景与 runner 阶段 3 完全等价：
 * - 立方体：8 顶点 8 色 + 36 索引 + 顶点色 shader + mvp uniform
 * - 双管线图：
 *     cube-pass（离屏，带深度）→ present-pass（采样到 swapchain）
 * - 边：cube-pass 输出的 offscreen-color → present-pass @binding(0) 采样
 *
 * 设计参考 docs/design/runner-render-pipeline.md（待写）+ 反向沉淀路径
 * （feedback_engine-implement-first-then-protocol：从硬编码值反向提炼为对象字段）。
 *
 * 本文件只描述数据；GPU 资源创建由 Renderer 在运行时按描述编译并缓存。
 */
import { mat4 } from 'gl-matrix'
import type {
  Model,
  Material,
  Pipeline,
  RenderObject,
  PipelineGraph,
  Attachment,
  VertexLayout,
  UniformFieldSpec,
} from '../types.js'
import { createRuntimeId } from '../ids.js'

/* ---------------- WGSL shader 源码 ---------------- */

/**
 * 立方体 shader：接收 position+color，乘 mvp 输出，片元输出顶点色。
 * @group(0)@binding(0) var<uniform> mvp: mat4x4f（uniform buffer，CPU 端算好一次写入）
 */
export const CUBE_WGSL = /* wgsl */ `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

@group(0) @binding(0) var<uniform> mvp: mat4x4f;

@vertex
fn vmain(
  @location(0) position: vec3f,
  @location(1) color: vec3f,
) -> VertexOut {
  var out: VertexOut;
  out.position = mvp * vec4f(position, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fmain(in: VertexOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
`

/**
 * 呈现 shader：全屏三角形（@builtin(vertex_index) 内嵌生成 3 顶点）采样离屏纹理。
 * @group(0)@binding(0) texture_2d<f32>（离屏 color attachment）
 * @group(0)@binding(1) sampler
 */
export const PRESENT_WGSL = /* wgsl */ `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vmain(@builtin(vertex_index) idx: u32) -> VertexOut {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  let p = positions[idx];
  var out: VertexOut;
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = vec2f((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}

@group(0) @binding(0) var offscreenTex: texture_2d<f32>;
@group(0) @binding(1) var texSampler: sampler;

@fragment
fn fmain(in: VertexOut) -> @location(0) vec4f {
  return textureSample(offscreenTex, texSampler, in.uv);
}
`

/* ---------------- 几何数据 ---------------- */

/**
 * 立方体顶点：8 顶点 × (3 pos + 3 color) = 48 floats。
 * 中心 (0,0,0)，边长 1（顶点在 ±0.5）。8 顶点 8 色，光栅化时按重心坐标插值。
 */
const CUBE_VERTICES = new Float32Array([
  //  x      y      z      r     g     b
  -0.5, -0.5, -0.5,  1.0,  0.0,  0.0,  // 0 红
  -0.5, -0.5,  0.5,  0.0,  1.0,  0.0,  // 1 绿
  -0.5,  0.5, -0.5,  0.0,  0.0,  1.0,  // 2 蓝
  -0.5,  0.5,  0.5,  1.0,  1.0,  0.0,  // 3 黄
   0.5, -0.5, -0.5,  1.0,  0.0,  1.0,  // 4 紫
   0.5, -0.5,  0.5,  0.0,  1.0,  1.0,  // 5 青
   0.5,  0.5, -0.5,  1.0,  1.0,  1.0,  // 6 白
   0.5,  0.5,  0.5,  1.0,  0.5,  0.0,  // 7 橙
])

/** 立方体索引：6 面 × 2 三角形 × 3 顶点 = 36 索引，CCW 朝外（配合 cullMode 'back'） */
const CUBE_INDICES = new Uint16Array([
  // 前 (+Z)
  1, 5, 7,  1, 7, 3,
  // 后 (-Z)
  4, 0, 2,  4, 2, 6,
  // 右 (+X)
  5, 4, 6,  5, 6, 7,
  // 左 (-X)
  0, 1, 3,  0, 3, 2,
  // 上 (+Y)
  3, 7, 6,  3, 6, 2,
  // 下 (-Y)
  0, 4, 5,  0, 5, 1,
])

/** 立方体顶点 buffer layout：arrayStride=6 floats，position @0 (vec3) + color @1 (vec3) */
const CUBE_VERTEX_LAYOUT: VertexLayout = {
  arrayStride: 6 * 4,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },      // position
    { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' },  // color
  ],
}

/* ---------------- 描述对象（一次性创建并复用；Renderer 用 id 缓存 + 场景切换 diff） ---------------- */

/** 立方体 Model */
export const CUBE_MODEL: Model = {
  id: 'mesh:cube',
  vertices: CUBE_VERTICES,
  indices: CUBE_INDICES,
  vertexLayouts: [CUBE_VERTEX_LAYOUT],
}

/**
 * 立方体 Material：顶点色材质，无静态字段（颜色来自顶点 @location(1)）。
 * mvp 是可变字段（每帧由 RenderObject 提供），不在 Material.fields 里。
 */
const CUBE_MATERIAL: Material = {
  id: 'mat:cube-vertex-color',
  name: '立方体顶点色材质',
  metadata: {},  // 顶点色材质无静态字段，Schema 为空
  fields: {},    // 无静态字段
  pipelineBindings: {
    // 立方体 pipeline 的 shader 没有从 Material 取的 uniform（mvp 来自 RO），映射为空
    'pipeline:cube-opaque': {},
  },
}

/** 立方体 Pipeline 的 uniform 字段布局：mvp mat4（64 字节，offset 0） */
const CUBE_UNIFORM_LAYOUT: UniformFieldSpec[] = [
  { name: 'mvp', type: 'float32x4x4', offset: 0, size: 64 },
]

/** 立方体 Pipeline：顶点色 shader + mvp uniform + 深度测试 + cullMode 'back' */
const CUBE_PIPELINE: Pipeline = {
  id: 'pipeline:cube-opaque',
  shaderSource: CUBE_WGSL,
  vertexEntryPoint: 'vmain',
  fragmentEntryPoint: 'fmain',
  bindings: [
    { binding: 0, kind: 'uniform-buffer', visibility: 'vertex', bufferSize: 64 },
  ],
  uniformBufferLayout: CUBE_UNIFORM_LAYOUT,
  topology: 'triangle-list',
  cullMode: 'back',
  depthState: {
    format: 'depth24plus',
    depthWriteEnabled: true,
    depthCompare: 'less',
  },
  colorTargets: [{ format: 'rgba8unorm' }],
  vertexBufferLayouts: [CUBE_VERTEX_LAYOUT],
}

/**
 * 呈现 Material：全屏三角形采样材质，无静态字段，无 uniform（只有纹理 binding）。
 */
const PRESENT_MATERIAL: Material = {
  id: 'mat:present-fullscreen',
  name: '全屏呈现材质',
  metadata: {},
  fields: {},
  pipelineBindings: {
    // present pipeline 的 shader 没有 uniform（只有 texture + sampler binding），映射为空
    'pipeline:present': {},
  },
}

/** 呈现 Pipeline 的 uniform 字段布局：空（present shader 无 uniform） */
const PRESENT_UNIFORM_LAYOUT: UniformFieldSpec[] = []

/** 呈现 Pipeline：triangle-list + 无 cull + 无 depth + swapchain format（运行时填）+ 无 vertex buffer */
function createPresentPipeline(swapchainFormat: string): Pipeline {
  return {
    id: 'pipeline:present',  // 稳定 id（colorTargets.format 区分 swapchain format）
    shaderSource: PRESENT_WGSL,
    vertexEntryPoint: 'vmain',
    fragmentEntryPoint: 'fmain',
    bindings: [
      { binding: 0, kind: 'sampled-texture', visibility: 'fragment', textureFormat: 'rgba8unorm' },
      { binding: 1, kind: 'sampler', visibility: 'fragment' },
    ],
    uniformBufferLayout: PRESENT_UNIFORM_LAYOUT,
    topology: 'triangle-list',
    cullMode: 'none',
    colorTargets: [{ format: swapchainFormat }],
    vertexBufferLayouts: [],  // 全屏三角形用 @builtin(vertex_index) 内嵌生成，无 vertex buffer
  }
}

/* ---------------- Attachment 声明 ---------------- */

/** 离屏颜色 attachment：rgba8unorm，跟随 swapchain 尺寸，被 present-pass 采样 */
const OFFSCREEN_COLOR_ATTACHMENT: Attachment = {
  name: 'offscreen-color',
  kind: 'color',
  format: 'rgba8unorm',
  size: { mode: 'swapchain' },
  sampledByLaterPass: true,
}

/** 离屏深度 attachment：depth24plus，跟随 swapchain 尺寸，不采样 */
const OFFSCREEN_DEPTH_ATTACHMENT: Attachment = {
  name: 'offscreen-depth',
  kind: 'depth',
  format: 'depth24plus',
  size: { mode: 'swapchain' },
  sampledByLaterPass: false,
}

/** swapchain attachment：每帧由 Renderer 取 getCurrentTexture（不创建） */
function createSwapchainAttachment(format: string): Attachment {
  return {
    name: 'swapchain',
    kind: 'swapchain',
    format,
    size: { mode: 'swapchain' },
    sampledByLaterPass: false,
  }
}

/* ---------------- 场景构建 ---------------- */

/**
 * 构建 MVP 矩阵（projection × view × model，gl-matrix 列主序）写入 64 字节 Float32Array。
 * - projection: perspective(60° fov, aspect, 0.1 near, 100 far)
 * - view: lookAt(eye=(0,0,4), target=(0,0,0), up=(0,1,0))
 * - model: 固定 rotateY(30°) × rotateX(20°)（静止视角，三视角可见）
 */
export function buildMvp(aspect: number): Float32Array {
  const projection = mat4.create()
  mat4.perspective(projection, Math.PI / 3, aspect, 0.1, 100)

  const view = mat4.create()
  mat4.lookAt(view, [0, 0, 4], [0, 0, 0], [0, 1, 0])

  const model = mat4.create()
  mat4.rotateY(model, model, 30 * Math.PI / 180)
  mat4.rotateX(model, model, 20 * Math.PI / 180)

  const mvp = mat4.create()
  mat4.multiply(mvp, projection, view)
  mat4.multiply(mvp, mvp, model)
  return mvp as Float32Array
}

/**
 * 构建立方体场景：返回 PipelineGraph + 一个 RenderObject（含 mvp uniform）。
 *
 * @param swapchainFormat GPUDevice.getPreferredCanvasFormat() 的返回值（如 'bgra8unorm'）
 * @param aspect canvas 物理宽高比（用于 perspective 投影矩阵）
 */
export function buildCubeScene(swapchainFormat: string, aspect: number): {
  graph: PipelineGraph
  cubeRenderObject: RenderObject
} {
  // 立方体 RenderObject：mvp 作为可变字段（每帧可能更新，如 resize 后 aspect 变化）
  // 运行时内部 id 由 createRuntimeId 生成（不可硬编码）
  const cubeRenderObject: RenderObject = {
    id: createRuntimeId(),
    model: CUBE_MODEL,
    material: CUBE_MATERIAL,
    fieldValues: new Map<string, Float32Array>([
      ['modelViewProj', buildMvp(aspect)],
    ]),
    pipelineBindings: {
      // 立方体 pipeline 的 shader uniform 'mvp' ← RO 的可变字段 'modelViewProj'
      'pipeline:cube-opaque': { 'mvp': 'modelViewProj' },
    },
  }

  const presentPipeline = createPresentPipeline(swapchainFormat)

  // 呈现 pass 的 RenderObject：无 model 几何（全屏三角形由 vertex_index 生成）
  // 但 RenderObject 接口要求 model；用一个空 model 占位（vertices 为空，indexCount=0）
  // Renderer 在 vertexBufferLayouts=[] + indexBuffer=null 时走 draw(3) 全屏三角形路径
  const PRESENT_MODEL: Model = {
    id: 'mesh:present-fullscreen-triangle',  // 内置占位资产，id 稳定
    vertices: new Float32Array(0),
    indices: undefined,
    vertexLayouts: [],
  }
  const presentRenderObject: RenderObject = {
    id: createRuntimeId(),
    model: PRESENT_MODEL,
    material: PRESENT_MATERIAL,
    fieldValues: new Map(),  // present shader 无 uniform，无可变字段
    pipelineBindings: {
      'pipeline:present': {},  // present shader 无 uniform，映射为空
    },
  }

  const graph: PipelineGraph = {
    id: createRuntimeId(),
    nodes: [
      {
        name: 'cube-pass',
        pipeline: CUBE_PIPELINE,
        renderObjects: [cubeRenderObject],
        colorAttachmentInputs: [],
        colorAttachmentOutputs: ['offscreen-color'],
        depthAttachment: 'offscreen-depth',
      },
      {
        name: 'present-pass',
        pipeline: presentPipeline,
        renderObjects: [presentRenderObject],
        colorAttachmentInputs: ['offscreen-color'],
        colorAttachmentOutputs: ['swapchain'],
      },
    ],
    edges: [
      {
        attachment: 'offscreen-color',
        from: 'cube-pass',
        to: 'present-pass',
        toBinding: 0,
      },
    ],
    attachments: [
      OFFSCREEN_COLOR_ATTACHMENT,
      OFFSCREEN_DEPTH_ATTACHMENT,
      createSwapchainAttachment(swapchainFormat),
    ],
  }

  return { graph, cubeRenderObject }
}

/** resize 时更新 cubeRenderObject 的 mvp uniform（aspect 变化） */
export function updateCubeMvp(cubeRenderObject: RenderObject, aspect: number): void {
  cubeRenderObject.fieldValues.set('modelViewProj', buildMvp(aspect))
}
