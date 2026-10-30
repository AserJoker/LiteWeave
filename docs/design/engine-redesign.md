# engine 重设计架构定稿

> 状态：设计定稿（2026-10-29）
> 背景：engine 模块反复打补丁无法根治渲染层问题，整体删除从头重设计（提交 `b57aa8f`）。本文记录重设计的完整架构决策。
>
> 前置：Runner 窗口基建已保留（`runnerWindowManager.js` + `runnerPreload.cjs` + `runner.html` + IPC 通道），新架构在此基础上重建。

## 1. 三段式架构

脚本移入渲染进程 **Web Worker**，WebGPU 留渲染进程**主线程**，资产文件 I/O 走 **Electron 主进程**。

```
Worker（渲染进程 Worker 线程）       ── 业务大脑：Scene 解析、ECS、脚本、命令缓冲区
  ↕ postMessage（渲染进程内）
渲染进程主线程                        ── 渲染器：命令消费、GPU 资源管理、渲染循环
  ↕ IPC（Electron 渲染↔主进程）
Electron 主进程                       ── 文件服务器：纯 fs 读字节，零业务逻辑
```

**分层职责：**
- **Worker**：唯一业务大脑。Scene 解析、RO 代理对象、命令缓冲区、脚本执行、ECS。reload 只影响 Worker。
- **渲染进程主线程**：只懂"资产字节 → GPU 对象"+"命令 → 状态机"。不感知 Scene/Entity/Component 等业务概念，但感知 PipelineGraph（纯渲染流程描述）。
- **Electron 主进程**：纯文件服务器（ID → 字节），不理解任何资产语义。未来换 Web 后端时这层直接替换。

## 2. 资产模型：按数据流向分类

**核心原则：按"谁生产数据"分类，而非按资产类型分类。**

| | 静态资产 | 动态资产 |
|---|---|---|
| **谁生产数据** | 磁盘（一次性加载） | 脚本/运行时（每帧或周期性变更） |
| **id 来源** | `<namespace>:<path>`（包内路径，磁盘稳定） | 脚本显式命名（字符串，如 `demogame:skeleton/spine`） |
| **Worker 侧** | 只存 id | id + ArrayBuffer（可读可写） |
| **主线程侧** | GPU 对象，`Map<id, GPUObject>` 缓存 | GPU 对象，`Map<id, GPUBuffer>` 缓存（复用） |
| **加载链路** | Worker 发 id → 主线程经 IPC 向后端拉字节 → 建 GPU 对象 | Worker 生成 ArrayBuffer → transfer 给主线程 |
| **写入主线程** | 一次性（加载时） | 变更时 transfer（按需，非每帧） |
| **reload 语义** | 随握手清空（不复用，开发态全量重置） | 随握手清空（随 Worker terminate 消亡） |
| **典型例子** | 纹理、静态模型顶点、shader、pipeline、graph | 骨骼动画顶点流、CPU 粒子、运行时生成几何 |

**关键约束：**
- 静态资产 Worker 侧**零字节持有**（只存 id），永不碰原始数据
- 动态资产主线程 GPUBuffer **复用**（首次建 buffer 缓存，后续 `queue.writeBuffer` 更新，只弃 transfer 来的临时 ArrayBuffer）
- 动态资产 id 由脚本显式命名（调试探针统一索引静态 + 动态）

## 3. Scene 与资产加载

**Scene 是 Worker 侧资源，主线程不感知 Scene。**

- 主线程没有 Scene 资源类型、没有 sceneLoader、不解析 scene JSON
- Worker 全权负责 Scene：读 JSON、解析资产 id 表、解析 RO 声明、组装批量加载指令
- 主线程只认两类指令：
  1. 批量加载资产：`loadAssets(ids)` → 主线程分流加载 + 建 GPU 对象 + 回 ack
  2. 命令缓冲区：`frame(commands)` → 主线程消费命令更新状态机

**Scene 资产 id 表（显式声明）：**
Scene JSON 顶层显式声明 `assets` 列表（不自动收集），Worker 据此组装加载指令。当前只渲染三件套（model/material/image），未来 i18n/data 也进这里。

**主线程感知 PipelineGraph：**
PipelineGraph 是纯渲染流程描述（pass 顺序 + attachment 流向），不是业务概念，主线程感知它（像加载 model/shader 一样加载 graph，编译成 `PipelineGraphRuntime`）。Scene 不感知是因为 Scene 是业务组合（含 camera/RO 这些脚本关心的东西）。

## 4. 通讯协议

### 4.1 通道分流

| 通道 | 方向 | 用途 | 语义 |
|---|---|---|---|
| `setScene` / `loadAssets` | Worker → 主线程（req/res） | 资产加载请求 | 立即发，等主线程 ack |
| `frame` | Worker → 主线程（单向） | 命令缓冲区批量提交 | commit 触发，主线程消费后更新状态机 |
| `cleared` / 通知 | 主线程 → Worker（单向） | 握手 ack、错误通知 | 无业务数据回传 |

**关键：Worker → 主线程是单向命令通道（通知双向）。** 主线程不向 Worker 回传业务数据，Worker 不"查询"主线程状态。

### 4.2 命令缓冲区

脚本调 `engine.render.*`（除 commit）只往**本地命令缓冲区** push 命令记录，`commit()` 才批量 postMessage 给主线程。

```
Worker → 主线程：{ type: 'frame', commands: Command[] }
Command =
  | { op: 'addRO', name, modelId, materialId, pipelineBindings, initialFields }
  | { op: 'removeRO', name }
  | { op: 'setField', name, field, value: Float32Array(transfer) }
  | { op: 'lockRO', name }
  | { op: 'unlockRO', name }
  | { op: 'setViewProjection', view: Float32Array(transfer), projection: Float32Array(transfer) }
  | { op: 'createDynamicBuffer', id, size, usage }
  | { op: 'writeDynamicBuffer', id, data: ArrayBuffer(transfer) }
  | { op: 'destroyDynamicBuffer', id }
```

## 5. Worker 生命周期握手

reload = 全量重置（仅开发态，不做热重载）。

**时序：**
1. 主线程 terminate 旧 Worker（或新建 Worker）
2. Worker 启动 → 发 `ready` 给主线程
3. 主线程收到 `ready` → **清空所有缓存**（静态 GPU 对象 + 动态 GPU 对象 + 运行时对象 + attachment）→ 回 `cleared`
4. Worker 收到 `cleared` → 开始执行脚本入口 → 重新请求所有资产、重建所有状态

**不做热重载**：静态资产每次 reload 重新加载可接受（开发态体验问题，非架构问题）。砍掉增量缓存/diff/引用计数复杂度。

## 6. engine API（Worker 侧）

脚本只看到注入的 `engine` 对象，命令式 API，**无通讯感知**。绝不出现 `engine.send(...)` / `engine.postMessage(...)` 这类通用通讯原语。

```ts
// === 入口 ===
engine.setScene(id: string): Promise<Scene>       // 解析 scene JSON + 批量加载资产 + 返回只读 Scene
engine.assets.load(ids: string[]): Promise<void>  // req/res，加载额外静态资产
engine.render: RenderAPI                           // 所有渲染命令（只写缓冲区）+ commit

// === Scene（只读数据，无方法） ===
interface Scene {
  name: string
  graph: string
  camera: { type, position, target, up, fov, near, far }  // 初始相机描述，脚本据此初始化自己的 Camera
  renderObjects: { name?: string, model, material, pipelineBindings }[]
  assets: { models: string[], materials: string[], images: string[] }
}

// === RenderAPI（所有方法只写缓冲区，commit 才提交） ===
interface RenderAPI {
  getRenderObject(name: string): RO
  addRenderObject(opts: {
    name: string                                    // 必填，全局唯一
    model: string
    material: string
    pipelineBindings: { [pipelineId: string]: { [field: string]: string } }
    initialFields?: { [field: string]: Float32Array }
  }): RO
  removeRenderObject(name: string): void
  setViewProjection(view: Float32Array, projection: Float32Array): void
  createDynamicBuffer(id: string, opts: { size: number, usage: GPUBufferUsageFlags }): void
  writeDynamicBuffer(id: string, data: ArrayBuffer): void
  destroyDynamicBuffer(id: string): void
  commit(): Promise<void>                           // 唯一提交点
}

// === RO（只写句柄，无 getter） ===
interface RO {
  setField(field: string, value: Float32Array): void
  lock(): void
  unlock(): void
  withLock(fn: () => void): void                    // 语法糖：lock + fn + unlock
  remove(): void
}
```

**RO 是只写句柄，不可读。** 脚本的业务状态自己封装（ECS Component），RO 影子只是"向主线程发命令的便利句柄"。脚本从自己的 Component 读业务数据（position/rotation/scale），算出矩阵 → `ro.setField('modelMatrix', m)` 单向推。

**name 句柄模型：**
- RO 用脚本显式传递的 `name` 作句柄（不用运行时整数 id）
- 静态 RO 无 name = 脚本不可访问，随 Scene 切换销毁
- name 全局唯一，重复 = 报错（脚本 bug）

**lock 机制（防多字段写入撕裂）：**
- RO 持 `lock: bool`，默认 false
- `ro.lock()` / `ro.unlock()` / `ro.withLock(fn)` 往命令缓冲区 push `lockRO` / `unlockRO`
- 主线程渲染时：RO.lock == true → 跳过该 RO instance uniform 写入，复用上一帧 buffer（global uniform 不受影响）
- commit 时 Worker 侧扫描命令缓冲区：发现 `lockRO(name)` 无配对 `unlockRO(name)` → 该 RO 的所有命令**全部剔除** + 发 `warn` 给主线程打印

## 7. 主线程渲染状态机

主线程持渲染状态机，Worker 通过命令变更状态机，rAF 驱动渲染。

```
RendererState（reload 随握手清空）
├─ graph: PipelineGraphRuntime | null              ── 编译自 graph JSON
├─ attachments: Map<name, GPUTexture>               ── lazy 建 + resize 全删重建
├─ ros: Map<name, RO>                               ── 按 name 索引
├─ staticAssets: Map<id, GPUObject>                 ── 静态 GPU 缓存
├─ dynamicBuffers: Map<id, GPUBuffer>               ── 动态 buffer 复用
├─ viewProjection: { view, projection }             ── 只存矩阵，无 Camera 概念
└─ pipelineCache: Map<pipelineId, GPURenderPipeline>
```

**主线程不感知 Camera，只感知 view/projection 矩阵。** Camera 类放 Worker 侧（脚本层），脚本算完矩阵调 `engine.render.setViewProjection(view, projection)` 推给主线程。

### 7.1 Uniform buffer 三层

- **全局**：`Map<pipelineId, GPUBuffer>` —— 每个被使用的 pipeline 一个 global uniform buffer，存 viewProjection 等 scope=global 字段，所有 RO 共享。每帧由 `setViewProjection` 命令更新。
- **实例**：`Map<roName, Map<pipelineId, GPUBuffer>>` —— 每个 RO 每条关联管线一个 instance uniform buffer，存 modelMatrix 等 scope=instance 字段。由 `setField` 命令更新。
- **动态资产**：`Map<dynamicId, GPUBuffer>` —— 脚本生成的顶点流等，由 `writeDynamicBuffer` 更新。

### 7.2 Attachment（lazy + resize 全删）

- graph 编译时只记 attachment **声明**（name/kind/format/size mode/采样方式/环绕方式），不建 GPU 纹理
- 渲染时某 pass 首次用到某 attachment → 按 size mode（默认跟 swapchain）+ 采样/环绕配置建 GPUTexture，缓存进 `attachments`
- resize（swapchain 尺寸变）→ 清空整个 attachments Map → 下一帧各 pass 重新 lazy 建

### 7.3 资产加载分流（统一入口）

`loadAssets(ids)` → 主线程经 IPC 拉字节 → 按 id 后缀/类型分流：
- `*.graph.json` → 编译成 PipelineGraphRuntime
- `*.pipeline.json` → 编译成 GPURenderPipeline
- `*.shader` / `*.wgsl` → GPUShaderModule
- `*.model.json` → GPUBuffer（顶点+索引）
- `*.mat.json` → 材质实例数据（小，只存描述）
- `*.png` 等 → GPUTexture

### 7.4 每帧渲染流程

1. 消费命令缓冲区 → 更新 RO 注册表 / fields / viewProjection / dynamic buffer
2. 按 graph passes 顺序：
   - lazy 建/取本 pass 的 input/output attachment
   - 写本 pass pipeline 的 global uniform（viewProjection）
   - 遍历可见 RO（按 RO.pipelineBindings 含本 pipelineId 筛选）
   - 写每个 RO 的 instance uniform（fields 按 uniformBufferLayout 的 offset 写入对应 buffer），lock 状态的 RO 跳过
   - 绑 global + instance uniform buffer → draw
3. 重复至所有 pass 完成，最后一个 pass 输出 swapchain

## 8. 实施顺序

1. **消息通道**（基础设施）：Worker ↔ 渲染主线程 postMessage 协议 + 渲染主线程 ↔ Electron 主进程 IPC 转发
2. **Worker 侧 engine API**：命令缓冲区 + RO 影子对象 + setScene 解析
3. **主线程状态机**：命令消费 + GPU 资源管理 + 渲染循环
4. **接入 Runner 窗口**：复用现有 runnerWindowManager

## 9. 关键决策汇总

| 决策点 | 选择 | 理由 |
|---|---|---|
| 脚本执行位置 | 渲染进程 Web Worker | 通讯降一个量级 + reload 解耦 + 不再有跨进程 Runner 生命周期坑 |
| WebGPU 位置 | 渲染进程主线程 | device 不可跨线程 transfer，主线程持 GPU 句柄 |
| 资产分类 | 按数据流向（静态/动态） | 统一规则，新增资产类型无需重新决策 |
| 静态资产 Worker 侧 | 只存 id | reload 复用 + Worker 零字节持有 |
| 动态资产 Worker 侧 | id + ArrayBuffer | 脚本可读可写，骨骼动画等场景必需 |
| 动态资产 GPUBuffer | 复用 | 避免每帧 GPUBuffer 分配，只弃临时 ArrayBuffer |
| Scene 归属 | Worker 侧 | 主线程不感知业务概念，Scene 演进不影响主线程 |
| PipelineGraph 归属 | 主线程感知 | 纯渲染流程描述，主线程理解 graph 天然 |
| RO 句柄 | 脚本显式 name | 不用运行时整数 id，调试可读 |
| RO 可读性 | 只写 | 业务数据脚本自己存（ECS），主线程不反向回传 |
| Camera 归属 | Worker 侧（脚本层） | 主线程只存 view/projection 矩阵 |
| reload 语义 | 全量重置 | 开发态不做热重载，砍掉增量/diff 复杂度 |
| 握手协议 | 阻塞式（ready → cleared → 执行） | 避免清空与执行的竞态 |
| 命令提交 | 批量（commit 触发） | 高频 API 不爆消息队列 |
| lock 机制 | per-RO，commit 时校验配对 | 防多字段写入撕裂 |
| commit 挂载 | engine.render | 全局统一提交点（动态资产不属 Scene） |
