# Runner 渲染流程设计（最小里程碑：三角形）

> 状态：设计定稿（2026-10-27）
> 决策：**Runner 渲染进程直接用浏览器原生 WebGPU（`navigator.gpu`）**，单管线渲染 RGB 插值三角形到 swapchain，作为引擎业务层的最小可验证里程碑。
>
> 前置：Runner 窗口基建（已完成，见 `app/src/runner/main.ts` + `desktop/src/runnerWindowManager.js`）；双窗口模型（见 `monaco-tsserver.md` §10）。
>
> 后续：本里程碑跑通后，进入 backpack PBR demo（优先级 2，资源加载/材质/纹理/mesh），反向沉淀资源协议到 `engine-layer.md`。

## 1. 背景与目标

### 1.1 为什么先渲染一个三角形

todo.md 优先级 2 的目标是 backpack PBR 渲染，但跨度过大：一次性要解决资源加载、OBJ 解析、5 张纹理绑定、PBR shader、材质参数、管线图等。先做三角形可以把"渲染链路本身"独立验证：

- **WebGPU 设备初始化**能否在 Electron 渲染进程跑通
- **swapchain 配置**与窗口尺寸联动是否正确
- **单管线（pipeline）创建**：shader + vertex buffer + render pass
- **主循环**（rAF）清理→draw→present 的帧时序
- **窗口 resize** 时 swapchain 重建
- **崩溃链路**：WebGPU 报错能否经主进程转发到 IDE 控制台

三角形跑通后，所有"渲染基础设施"问题都已解决，后续 PBR demo 只是在同一套基础设施上加资源加载和更复杂的 shader/bindings。

### 1.2 最小里程碑定义

**渲染目标**：屏幕中央一个等边三角形，三个顶点分别为红/绿/蓝，光栅化后颜色按重心坐标插值，铺满三角形内部。

**不包含**：
- 资源加载（.scene/.texture/.material/.pipeline 等协议——延后到 PBR demo 反向沉淀）
- 多管线 / 管线图（DAG）
- 脚本运行时（脚本控制参数）
- 引擎业务层 workspace 拆分（三角形直接写在 `app/src/runner/` 下）
- 物理输入/相机控制（无交互，静态一帧 + rAF 持续 present）
- 诊断层（FPS overlay 等——留到 PBR demo）

### 1.3 关键决策（与用户定案）

| 决策点 | 选择 | 理由 |
|---|---|---|
| GPU 后端 | 浏览器原生 WebGPU（`navigator.gpu`） | Electron 44 内置 Chromium 152 已稳定支持 WebGPU；零依赖；符合 `project_engine-web-architecture` 中 Web 后端原生 WGSL 路径 |
| Shader 来源 | 硬编码字符串内嵌在 `app/src/runner/shaders.ts` | 符合 `feedback_engine-implement-first-then-protocol`（先硬编码再沉淀）；最小里程碑不动资源加载链路 |
| engine workspace | **延后创建** | 三角形直接写在 `app/src/runner/` 下；验证渲染链路通后再拆 `engine/` workspace 暴露业务层 API |
| 渲染入口 | Runner 主循环直接调 WebGPU | 不引入引擎抽象层；下一阶段（PBR demo）才把硬编码值反向提炼成 `engine.d.ts` API |

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│  Runner 渲染进程（Electron BrowserWindow，独立进程）          │
│                                                              │
│  ┌──────────────────────┐    ┌──────────────────────────┐  │
│  │  runner.html          │    │  runner/main.ts           │  │
│  │  ┌────────────────┐  │    │  ┌────────────────────┐  │  │
│  │  │ <canvas>       │◀─┼────│  │ Renderer           │  │  │
│  │  │ (WebGPU)       │  │    │  │  - init gpu/device  │  │  │
│  │  └────────────────┘  │    │  │  - configure ctx    │  │  │
│  │  ┌────────────────┐  │    │  │  - build pipeline   │  │  │
│  │  │ <div info card>│  │    │  │  - rAF loop         │  │  │
│  │  └────────────────┘  │    │  └────────────────────┘  │  │
│  └──────────────────────┘    └──────────────────────────┘  │
│                                                              │
│  ┌──────────────────────┐    ┌──────────────────────────┐  │
│  │  runner/shaders.ts    │    │  runner/webgpuHelpers.ts  │  │
│  │  WGSL_TRANGLE = `...`│    │  - getGpuDevice()         │  │
│  │  (vertex + fragment)  │    │  - configureCanvas()      │  │
│  └──────────────────────┘    └──────────────────────────┘  │
└──────────────────────────────┼─────────────────────────────┘
                               │ IPC（runner:* channel）
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  主进程（Electron）                                          │
│  - runner:ready / heartbeat / console → 推 IDE              │
│  - 生命周期管理（已实现，见 runnerWindowManager.js）         │
└─────────────────────────────────────────────────────────────┘
```

**核心边界**：
1. **WebGPU 在 Runner 渲染进程跑**（不在主进程，不在 IDE 进程）
2. **三角形代码直接写在 `app/src/runner/`**（不引入 engine workspace）
3. **主进程不感知渲染**（只透传 console 日志和生命周期事件到 IDE）
4. **IDE 不直连 Runner**（所有状态经主进程中转，已有基建复用）

## 3. WebGPU 初始化链路

### 3.1 设备获取

```typescript
// runner/webgpuHelpers.ts
export async function getGpuDevice(): Promise<GPUDevice> {
  if (!('gpu' in navigator)) {
    throw new Error('当前环境不支持 WebGPU（需 Electron 44+ / Chromium 152+）')
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  })
  if (!adapter) {
    throw new Error('未找到可用 GPU adapter')
  }
  const device = await adapter.requestDevice({
    requiredFeatures: [],
    requiredLimits: {},
  })
  return device
}
```

**异常处理**：
- `navigator.gpu` 不存在 → 抛错，主进程经 `console-message` 事件转发到 IDE 控制台，Runner 状态面板显示红色错误
- `requestAdapter` 返回 null → 同上
- `requestDevice` 失败（如驱动不兼容）→ 同上
- `device.lost` Promise 在运行时 reject → 监听并上报主进程，IDE 显示"GPU 设备丢失"提示

### 3.2 Canvas 与 swapchain 配置

WebGPU 在 canvas 上的呈现走 `GPUCanvasContext.configure()`：

```typescript
export function configureCanvas(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  format?: GPUTextureFormat,
): GPUCanvasContext {
  const ctx = canvas.getContext('webgpu')
  if (!ctx) throw new Error('canvas.getContext("webgpu") 返回 null')
  const targetFormat = format ?? navigator.gpu.getPreferredCanvasFormat()
  ctx.configure({
    device,
    format: targetFormat,
    alphaMode: 'opaque',
  })
  return ctx
}
```

**关键点**：
- 使用 `navigator.gpu.getPreferredCanvasFormat()`（BGR8 或 RGBA8，按平台）；不硬编码 `bgra8unorm`，跨平台兼容
- `alphaMode: 'opaque'`：三角形 demo 不需要透明合成
- `configure()` 不会创建 swapchain 纹理，每帧 `getCurrentTexture()` 才取当前帧纹理

### 3.3 窗口尺寸联动

canvas 的 CSS 像素尺寸 ≠ 物理像素尺寸（高 DPI 屏）。Runner 窗口可被用户 resize，需要：

```typescript
function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): boolean {
  const dpr = window.devicePixelRatio || 1
  const displayWidth = Math.floor(canvas.clientWidth * dpr)
  const displayHeight = Math.floor(canvas.clientHeight * dpr)
  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth
    canvas.height = displayHeight
    return true  // 尺寸变了
  }
  return false
}
```

`ResizeObserver` 监听 canvas 容器尺寸变化 → 调用 `resizeCanvasToDisplaySize` → 下一帧 `getCurrentTexture()` 自动返回新尺寸的 swapchain 纹理（WebGPU 自动重建 swapchain，不需要手动 `unconfigure()`）。

## 4. 三角形数据与 shader

### 4.1 顶点数据

三角形 3 个顶点，每顶点 5 个 float：`[x, y, r, g, b]`（位置 2D + 颜色 RGB）。

```typescript
// 顶点布局：[x, y, r, g, b] × 3 = 60 字节
const VERTICES = new Float32Array([
  //  x      y     r     g     b       （归一化设备坐标，中心 (0,0)）
   0.0,  0.6,  1.0,  0.0,  0.0,   // 顶部红
  -0.6, -0.4,  0.0,  1.0,  0.0,   // 左下绿
   0.6, -0.4,  0.0,  0.0,  1.0,   // 右下蓝
])

const vertexBuffer = device.createBuffer({
  size: VERTICES.byteLength,  // 60 字节（ceil 到 4 字节对齐）
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
})
device.queue.writeBuffer(vertexBuffer, 0, VERTICES)
```

**顶点 buffer layout**（pipeline 用）：
```typescript
const vertexBufferLayout: GPUVertexBufferLayout = {
  arrayStride: 5 * 4,  // 5 floats × 4 bytes
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' },  // position
    { shaderLocation: 1, offset: 2 * 4, format: 'float32x3' },  // color
  ],
}
```

### 4.2 WGSL shader（硬编码字符串）

```wgsl
// runner/shaders.ts
export const TRIANGLE_WGSL = /* wgsl */ `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

@vertex
fn vmain(
  @location(0) position: vec2f,
  @location(1) color: vec3f,
) -> VertexOut {
  var out: VertexOut
  out.position = vec4f(position, 0.0, 1.0)
  out.color = color
  return out
}

@fragment
fn fmain(in: VertexOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0)
}
`
```

**要点**：
- 2D 位置直接当 NDC（归一化设备坐标）用，不做矩阵变换（最小里程碑不需要 MVP）
- 颜色 `@location(0)` 从顶点传到 fragment，WebGPU 自动按重心坐标插值
- fragment 输出 `@location(0)` = swapchain 纹理的 RTV（render target 0）

### 4.3 pipeline 创建

```typescript
const shaderModule = device.createShaderModule({ code: TRIANGLE_WGSL })

const pipeline = device.createRenderPipeline({
  layout: 'auto',  // 无 binding group，auto 让 WebGPU 自动推断
  vertex: {
    module: shaderModule,
    entryPoint: 'vmain',
    buffers: [vertexBufferLayout],
  },
  fragment: {
    module: shaderModule,
    entryPoint: 'fmain',
    targets: [
      { format: targetFormat },  // 与 canvas configure 的 format 一致
    ],
  },
  primitive: {
    topology: 'triangle-list',
  },
})
```

**关键决策**：
- `layout: 'auto'`：本里程碑无 uniform/binding，auto 让 WebGPU 自动生成 layout；下一阶段加 uniform（如 MVP 矩阵）时改用显式 `GPUPipelineLayout`
- `topology: 'triangle-list'`：3 顶点直接画一个三角形（不需要 index buffer）
- `targets[0].format` 必须与 `ctx.configure({ format })` 一致，否则 pipeline 创建报错

## 5. 主循环（render loop）

### 5.1 帧时序

```
┌─ rAF callback ─────────────────────────────────────────┐
│  1. resize 检查（如变化，重配 swapchain）              │
│  2. device.queue.writeBuffer（如 vertex buffer 动态）  │ ← 本里程碑静态，跳过
│  3. ctx.getCurrentTexture() → 当前帧 swapchain 纹理    │
│  4. encoder = device.createCommandEncoder()            │
│  5. pass = encoder.beginRenderPass({                   │
│       colorAttachments: [{                             │
│         view: texture.createView(),                    │
│         clearValue: { r:0, g:0, b:0, a:1 },            │ ← 清理色（黑）
│         loadOp: 'clear',                               │ ← 清理 → 三角形 → swapchain
│         storeOp: 'store',                              │
│       }],                                              │
│     })                                                 │
│  6. pass.setPipeline(pipeline)                         │
│  7. pass.setVertexBuffer(0, vertexBuffer)              │
│  8. pass.draw(3)                                       │
│  9. pass.end()                                         │
│ 10. device.queue.submit([encoder.finish()])            │
│ 11. rAF 下一帧                                         │
└────────────────────────────────────────────────────────┘
```

### 5.2 实现骨架

```typescript
// runner/main.ts（伪代码，实际见 §8 实施步骤）
async function startRenderLoop(canvas: HTMLCanvasElement, device: GPUDevice, pipeline: GPURenderPipeline, vertexBuffer: GPUBuffer, ctx: GPUCanvasContext, format: GPUTextureFormat) {
  const frame = () => {
    // 1) 尺寸检查
    resizeCanvasToDisplaySize(canvas)

    // 3) 取当前帧 swapchain 纹理
    const swapchainTexture = ctx.getCurrentTexture()

    // 4-5) 创建 encoder + render pass
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: swapchainTexture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    })

    // 6-8) 绑定 + draw
    pass.setPipeline(pipeline)
    pass.setVertexBuffer(0, vertexBuffer)
    pass.draw(3)
    pass.end()

    // 10) 提交
    device.queue.submit([encoder.finish()])

    // 11) 下一帧
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
```

### 5.3 不做的事

- **不做帧率限制**：rAF 自然限制到显示器刷新率（通常 60Hz）；三角形 demo 不需要 fixed timestep
- **不做脏标记优化**：每帧都 draw（虽然三角形静态）；脏标记优化留到场景有动态对象时
- **不做 vsync 检测**：WebGPU swapchain 默认 vsync，无需配置

## 6. 错误处理与诊断

### 6.1 GPU 错误回调

```typescript
device.pushErrorScope('validation')
// ... 创建 pipeline / buffer 等
device.popErrorScope().then((error) => {
  if (error) {
    console.error('[gpu] validation error:', error.message)
    // 主进程 console-message 事件捕获 → 转发 IDE 控制台
  }
})

// 全局未捕获错误
device.addEventListener('uncapturederror', (event) => {
  console.error('[gpu] uncaptured error:', event.error.message)
})
```

### 6.2 device.lost 监听

```typescript
device.lost.then((info) => {
  console.error(`[gpu] device lost: reason=${info.reason}, message=${info.message}`)
  // 上报主进程 → IDE 显示"GPU 设备丢失，请重启 Runner"
})
```

### 6.3 错误传播链路

```
Runner 内 console.error
  → Electron webContents 'console-message' 事件
  → runnerWindowManager 的 onConsole 回调
  → pushRunnerEventToIDE({ type: 'console', entry })
  → IDE preload onRunnerEvent
  → runnerService.handleEvent → 广播 RUNNER_CONSOLE 事件
  → （未来）Runner 控制台面板显示
```

当前链路已通（runnerWindowManager 已收集 console-message 推 IDE），但 IDE 端还没控制台面板消费（属遗留事项 §3）。本里程碑验证：故意写错 shader 看 console 日志是否经主进程到达 IDE（用 MCP `debug_eval_main` 抓 Runner webContents 日志验证）。

## 7. UI 布局

Runner 窗口当前是单卡片（项目信息 + 心跳）。加 WebGPU canvas 后改为左右布局：

```
┌──────────────────────────────────────────────────────────┐
│  LiteWeave Runner                          ● running      │
├──────────────────────────────────────────────────────────┤
│                          │                                │
│                          │  项目：DemoGame rd3f           │
│      ┌────────────┐      │  根目录：...                   │
│      │            │      │  入口场景：demogame:scenes/... │
│      │   canvas   │      │  ─────────────                 │
│      │  (WebGPU)  │      │  GPU：AdaptiveSync / D3D12     │
│      │            │      │  Format：bgra8unorm            │
│      │   三角形    │      │  分辨率：1280×720 @ 1.5 dpr    │
│      └────────────┘      │  帧计数：1234                  │
│                          │  心跳：24                      │
│                          │  最近事件：runner:reload @ ... │
│                          │                                │
├──────────────────────────────────────────────────────────┤
│  引擎业务层尚未接入（优先级 2 待实施）。当前仅渲染三角形。  │
└──────────────────────────────────────────────────────────┘
```

- canvas 占左侧 70%，右侧 30% 是信息卡片
- canvas 容器自适应窗口尺寸，ResizeObserver 触发 swapchain 重配
- 信息卡片显示 GPU 诊断信息（adapter 信息、format、当前分辨率、帧计数）+ 现有项目信息 + 心跳

CSS 在 `app/src/runner/runner.css` 已有暗色卡片样式，加 canvas 容器与左右布局即可。

## 8. 实施步骤

按以下顺序实施，每步独立验证：

### 步骤 1：WebGPU 检测与设备初始化
- 新建 `app/src/runner/webgpuHelpers.ts`：`getGpuDevice()` + `configureCanvas()`
- 修改 `runner/main.ts`：bootstrap 后调用 `getGpuDevice()`，失败时状态面板显示错误
- 验证：`debug_eval_main` 抓 Runner `adapter.info` 字段，确认 GPU 后端可用

### 步骤 2：canvas 与 UI 布局
- 修改 `runner.html`：加 `<canvas id="runner-canvas">` + 调整信息卡片布局
- 修改 `runner/main.ts`：调 `configureCanvas()`，信息卡片显示 adapter 信息 + format
- 修改 `runner/runner.css`：左右布局 + canvas 容器样式
- 验证：canvas 显示一片黑（清理色），无报错

### 步骤 3：WGSL shader 与 pipeline
- 新建 `app/src/runner/shaders.ts`：`TRIANGLE_WGSL` 常量
- 修改 `runner/main.ts`：创建 shaderModule + vertexBuffer + pipeline
- 验证：pipeline 创建无 validation error（用 `pushErrorScope('validation')` 抓）

### 步骤 4：渲染循环
- 修改 `runner/main.ts`：实现 `startRenderLoop()`，rAF 持续 draw
- 验证：屏幕看到 RGB 插值三角形，状态变 `running`

### 步骤 5：resize 适配
- 修改 `runner/main.ts`：加 `ResizeObserver` + `resizeCanvasToDisplaySize()`
- 验证：拖动 Runner 窗口尺寸，三角形不变形、不消失

### 步骤 6：错误链路验证
- 故意写错 shader（如改 entryPoint 名）→ 看 console-message 是否经主进程到达 IDE
- 修复后回归正常
- 验证：MCP `debug_eval_main` 抓 Runner webContents 日志，确认错误链路通

### 步骤 7：状态联动
- 修改 `runner/main.ts`：渲染循环开始时上报 `runner:console`（含 GPU 信息），状态 `ready → running`
- 信息卡片显示帧计数（每 60 帧更新一次，避免重渲染开销）
- 验证：IDE 工具栏圆点变绿（running），F5 reload 后三角形重渲染

## 9. 验收标准

- [ ] Runner 窗口左侧 canvas 显示 RGB 三角形（顶点红/绿/蓝，内部按重心坐标插值）
- [ ] 三角形位置：屏幕中央，等边三角形（顶点在 (0, 0.6)，底边在 y=-0.4）
- [ ] 背景：纯黑（clearValue 黑）
- [ ] 拖动 Runner 窗口尺寸，三角形不变形、不消失，canvas 物理分辨率跟随 dpr
- [ ] F5 / 工具栏"重载"按钮 → Runner 重新加载页面，三角形重新渲染
- [ ] 故意写错 shader → IDE 经主进程收到 console 日志（用 MCP `debug_eval_main` 验证）
- [ ] Runner 状态：starting → ready（设备就绪）→ running（渲染循环启动），IDE 圆点对应颜色
- [ ] 信息卡片显示：GPU adapter 信息、canvas format、当前分辨率、帧计数

## 10. 不做的事（明确边界）

- **不创建 `engine` workspace**：三角形代码直接写在 `app/src/runner/` 下；下一阶段（PBR demo）才拆 engine workspace
- **不做资源加载**：WGSL 硬编码字符串、顶点数据硬编码 Float32Array；不引入 .shader / .scene / .material 资源协议
- **不做引擎 API 抽象**：不暴露 `engine.createRenderer()` / `engine.renderSceneOnce()` 等接口；下一阶段从硬编码反向沉淀
- **不做多管线 / 管线图**：单 pipeline，单 render pass，单 color attachment
- **不做 uniform / binding group**：无 MVP 矩阵、无时间 uniform、无纹理 binding
- **不做脚本运行时**：Runner 不跑用户脚本，只跑硬编码的渲染循环
- **不做 IDE 静态预览**：`renderSceneOnce()` 接口留到下一阶段；本里程碑只在 Runner 跑
- **不做帧率控制 / fixed timestep**：rAF 自然刷新率
- **不做 FPS overlay / 性能监控 UI**：留到 PBR demo

## 11. 后续衔接（PBR demo 路径）

本里程碑跑通后，下一步按 `todo.md` 优先级 2 实施 backpack PBR demo。从本里程碑到 PBR demo 的增量工作：

1. **新建 `engine` workspace**：把 `app/src/runner/webgpuHelpers.ts` 和渲染循环逻辑迁移到 `engine/`，暴露 `createRenderer(canvas)` / `renderer.renderFrame(scene)` API
2. **资源加载**：从硬编码 shader → `.shader.wgsl` 文件加载；从硬编码顶点 → `.model` 文件（OBJ 解析）；从硬编码颜色 → `.material` + `.texture` 绑定
3. **多 binding**：uniform buffer（MVP 矩阵）+ sampled texture（5 张 PBR 贴图）+ sampler
4. **场景图 / RenderObject**：从单 draw call → 遍历 RenderObject 池多次 draw
5. **反向沉淀**：从 demo 硬编码值反向提炼 `.model` / `.material` / `.pipeline` / `.texture` 字段结构，写入 `docs/design/engine-layer.md`

本里程碑的"WebGPU 设备初始化 / swapchain 配置 / 主循环 / resize 适配 / 错误链路"全部复用，不重写。

## 12. 关键风险与缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| Electron 渲染进程 WebGPU 不可用 | 低 | Chromium 152 已稳定；启动时检测 `navigator.gpu`，失败给清晰错误提示 |
| 用户机器驱动过旧 | 中 | `requestAdapter` 返回 null 时提示"请更新显卡驱动"；可考虑后续加 WebGL2 兜底（本里程碑不做） |
| `getPreferredCanvasFormat()` 与 shader 输出 format 不一致 | 低 | pipeline 创建时用同一 format 变量；validation error 会立即报错 |
| resize 时 swapchain 重建卡顿 | 低 | WebGPU 自动管理 swapchain 重建，不需要 unconfigure；ResizeObserver 节流 |
| `device.lost` 在运行时触发 | 低 | 监听并上报主进程，IDE 显示"重启 Runner"提示 |
| 多窗口/多 Runner 实例 GPU 资源争用 | 低 | RunnerWindowManager 单例语义，同一时刻只有一个 Runner |

---

## 附：与既有架构的对接点

| 既有模块 | 对接方式 |
|---|---|
| `runnerWindowManager.js` | 无需改；Runner 内 console 自动经 `console-message` 事件收集转发 |
| `runnerPreload.cjs` | 无需改；`invoke('runner:console', payload)` 主动上报日志（与 webContents console-message 互补） |
| `runner/main.ts` | 主入口改造：bootstrap 后调 `getGpuDevice()` → `configureCanvas()` → 创建 pipeline → 启动 rAF 循环 |
| `runner.html` | 加 `<canvas>` 元素 |
| `runner/runner.css` | 加 canvas 容器与左右布局样式 |
| `runnerService.ts` | 无需改；RUNNER_CONSOLE 事件已广播，IDE 控制台面板（未来）订阅即可 |
| IDE 工具栏 | 无需改；Runner 状态指示圆点已就绪，颜色由 status 决定 |
| MCP `system.runner:*` 命令 | 无需改；start/stop/reload/status 已就绪 |
