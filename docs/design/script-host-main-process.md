# 脚本宿主迁主进程设计（v0.2 演进）

## 实施阶段划分

### 第一阶段（本次实施）：仅搬宿主 + tick 末推值

**范围**：把脚本宿主从 Runner 搬到主进程，tick 计算逻辑不变（脚本仍每 tick 算 modelMatrix），tick 末批量推 dirty 值给 Runner 应用。

**不做**：
- 动画系统 / 意图模型（后续单独迭代）
- 输入事件（键盘/鼠标 IPC）
- 相机同步模型改造（仍用 v0.1 的 camera.apply 闭包，但 apply 写 dirty 缓冲而非直接调 renderer，tick 末推 view/projection 矩阵给 Runner）
- onResize 推主进程（Runner 本地兜底重算 projection，与 v0.1 一致）

**脚本 API**：与 v0.1 完全一致（`engine.scene.setField` / `engine.camera.apply()` / `engine.time` / `engine.canvas` / `engine.log`），DemoGame `scripts/main.js` 无需改。

**关键变化**：
- 主进程：新增 `scriptHost.ts`（加载 Scene + 脚本 + tick + dirty 缓冲 + flush）
- Runner：删除脚本/tick/Scene 加载/AssetLoader/engine 对象/Camera 实例；新增消费 `scene-ready`/`tick-delta` 事件
- camera.apply 闭包：从"直接调 renderer.setView/setProjection"改为"写 dirty 缓冲"，tick 末推矩阵

### 第二阶段（后续）：动画系统 / 意图模型

脚本设意图（角速度/目标），前端动画组件每帧插值。见下文"意图模型"章节。用户对此阶段架构仍在思考，本文档后续章节作为方向参考，非本次实施范围。

### 第三阶段（后续）：输入事件 + 相机控制器

键盘输入 IPC 推主进程；相机内置模式 + 鼠标本地处理。见下文"相机控制器"章节。

---

## 第一阶段设计（本次实施）

### 定位与动机

v0.1（见 `script-system.md`，任务 #51 已落地）把脚本宿主放在 Runner 渲染进程内，与渲染循环共享内存。这适合最小闭环验证，但不符合真实引擎架构：

> **真实引擎的脚本线程 ≠ 渲染线程**。脚本跑业务逻辑，渲染跑 GPU 输出，二者隔离。

v0.2 把脚本宿主从 Runner 搬到 Electron **主进程**，并确立**意图/状态模型**而非"每帧推值"模型。

### 核心原则：意图模型（不是值同步）

**反模式（被否定）**：后端每 tick 算出 modelMatrix 推给前端 → 前端直接渲染。这把脚本变成"每帧计算器"，违背"脚本是决策层不是计算层"，且 tick（50ms）频率不够支撑流畅动画。

**正确模式**：后端设**意图/状态**（角速度、目标姿态、相机模式），前端**动画系统**每帧根据意图插值算实际渲染值。

```
┌────────── 后端（主进程）──────────┐
│  脚本设意图（tick 级 50ms）        │
│  - engine.ro.setAngularVelocity(id, [0,1,0])  // 绕 Y 轴 1 rad/s
│  - engine.camera.mode = 'orbit'   // 相机模式
│  - engine.ro.setColor(id, [1,0,0]) // 非动画字段直接设值
└───────────────────────────────────┘
              ↓ IPC（tick 末批量推意图变更 + 非动画值）
┌────────── 前端（Runner）──────────┐
│  动画系统（帧级 rAF）              │
│  - Rotation 组件：按角速度 × dt 算 modelMatrix
│  - 相机控制器：按 mode + 鼠标输入本地算 view/projection
│  - 非动画字段：直接应用到 RO.fieldValues
│  渲染器：消费渲染值调 GPU          │
└───────────────────────────────────┘
```

| 层 | 职责 | 频率 |
|---|---|---|
| **后端脚本** | 设意图/状态/绑定（角速度、目标姿态、相机模式、非动画字段值） | tick 级（50ms） |
| **前端动画组件** | 每帧根据意图插值算实际渲染值（modelMatrix 等） | 帧级（rAF） |
| **前端相机控制器** | 按 mode + 鼠标输入本地高频率算 view/projection | 帧级（rAF，鼠标不经 IPC） |
| **前端渲染器** | 消费渲染值调 GPU | 帧级（rAF） |

## 三类字段的不同同步路径

| 字段类型 | 例子 | 后端动作 | 前端动作 |
|---|---|---|---|
| **动画字段** | modelMatrix（旋转/平移/缩放） | 脚本设意图（角速度/目标姿态）→ tick 末推意图变更 | 动画组件每帧按意图插值算实际值 |
| **非动画字段** | 材质颜色、可见性、纹理 id | 脚本 tick 设值 → tick 末推值 | 直接应用到 RO.fieldValues |
| **相机** | view/projection 矩阵 | 脚本设 mode + 参数（orbit 距离/俯仰等）→ tick 末推相机参数 | 相机控制器每帧按 mode + 本地鼠标输入算 view/projection |

**关键**：相机 view/projection 矩阵**不进 IPC**。后端只推相机模式 + 参数，前端本地控制器算矩阵。FPS 敏感的鼠标输入在前端本地处理，不推主进程（避免 50ms tick 延迟 + IPC 开销）。

### 第一阶段数据流

```
┌──────────────────────── 主进程（业务权威）────────────────────────┐
│                                                                  │
│  1. runner:start                                                 │
│     ├─ AssetLoader（Node fs）加载 Scene                          │
│     │  → 得到 graph + RO 元信息 + camera 初始态                   │
│     ├─ 构造 engine 全局对象（与 v0.1 API 一致）                   │
│     ├─ new Function 包裹加载 entryScript → 拿 exports 钩子         │
│     ├─ 调 onInit                                                  │
│     └─ 推「场景就绪」给 Runner（含 pipeline 描述 + 顶点/索引 +     │
│        字段映射 + 初始 camera，让 Runner 建 GPU 资源）            │
│                                                                  │
│  2. tick 循环（setInterval 50ms，与 v0.1 一致）                    │
│     ├─ engine.time 更新                                          │
│     ├─ 调脚本 onTick(dt)                                          │
│     │  脚本调 engine.scene.setField(roId, name, value)            │
│     │  → 写入主进程 RO.fieldValues（权威）+ dirty 缓冲            │
│     │  脚本调 engine.camera.position = [...] + camera.apply()     │
│     │  → apply 闭包算 view/projection 矩阵 → 写 dirty 缓冲         │
│     ├─ tick 末：批量推 dirty 给 Runner（一次 IPC）                 │
│     │  payload: { dirtyFields: [{roId, fieldName, value}],         │
│     │            camera: { view?, projection? } }                  │
│     └─ 清空 dirty 缓冲                                            │
│                                                                  │
│  3. 脚本抛错 → catch → 停脚本（清钩子）+ 状态 error                │
│     → 推 script-error 给 Runner（Runner 显示错误态，渲染继续）     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                              ↓ IPC（runner:event）
┌──────────────────────── Runner 渲染进程（纯渲染器）────────────────┐
│                                                                  │
│  1. 收「场景就绪」                                                │
│     ├─ 用 pipeline 描述编译 GPU pipeline                          │
│     ├─ 用顶点/索引数据建 GPU buffer                               │
│     ├─ 建 UniformBuffer（per-RO per-pipeline + global）           │
│     ├─ 用初始 camera 算 view/projection 调 setView/setProjection  │
│     └─ 进入渲染循环（rAF）                                        │
│                                                                  │
│  2. 渲染循环（rAF，独立于 tick）                                   │
│     ├─ 收主进程推的 dirty（异步，非每帧）：                         │
│     │  - dirtyFields → 写 RO.fieldValues                          │
│     │  - camera.view/projection → renderer.setView/setProjection   │
│     ├─ resize 检查（本地兜底重算 projection，与 v0.1 一致）         │
│     ├─ renderer.renderGraph(graph, scene)                         │
│     └─ frameCount++                                               │
│                                                                  │
│  3. 不采集输入（第一阶段不做）                                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 第一阶段 IPC 协议

#### 主进程 → Runner（经 `runnerManager.sendToRunner`，走 `runner:event` channel）

| type | 时机 | payload | Runner 动作 |
|---|---|---|---|
| `scene-ready` | Runner ready 后一次性 | `{ graph, renderObjects, camera, canvasSize }` | 编译 pipeline + 建 GPU 资源 + 初始 camera 矩阵 + 进渲染循环 |
| `tick-delta` | 每 tick 末 | `{ tickCount, dirtyFields, camera }` | dirtyFields → 写 RO.fieldValues；camera → setView/setProjection |
| `script-error` | 脚本抛错 | `{ message }` | 显示错误态，渲染继续（立方体停在最后状态） |
| `reload` | runner:reload | `{}` | 清错误态，主进程会重推 scene-ready 或 tick-delta |
| `stop` | runner:stop | `{}` | 停渲染循环 + 释放 GPU 资源 |

#### Runner → 主进程（经 `bridge.invoke`，走 `runner:*` IPC channel）

| channel | 时机 | payload | 主进程动作 |
|---|---|---|---|
| `runner:ready` | Runner WebGPU 就绪 | `{ gpuReady, gpuInfo }` | markReady；推 scene-ready |
| `runner:heartbeat` | 每 2s | `{ seq }` | 转发给 IDE 显示 |
| `runner:console` | Runner 主动日志 | `{ level, message }` | 转发给 IDE 控制台 |

**第一阶段不做**：`runner:input-event`（键盘/鼠标/resize 推主进程）。

### 第一阶段 scene-ready payload 序列化

Scene 对象含 GPU 无关的描述数据，需序列化推给 Runner。关键：Float32Array → number[]（IPC 结构化克隆传 TypedArray 开销大，统一用普通数组）。

```typescript
{
  type: 'scene-ready',
  graph: PipelineGraph,              // 直接序列化（纯数据结构）
  renderObjects: Array<{
    id: number,
    model: Model,                    // 含顶点/索引（ArrayBuffer 序列化为 number[]）
    material: Material,              // 静态字段 + pipelineBindings
    pipelineBindings: Record<string, Record<string, string>>,
    initialFieldValues: Record<string, number[]>,  // 初始字段值（如 identity modelMatrix）
  }>,
  camera: Camera,                    // 初始相机（type/position/target/up/fov/near/far）
  canvasSize: { width: number, height: number },
}
```

**Model 顶点数据序列化**：现有 Model 持 Float32Array（positions/normals/colors）+ Uint32Array（indices）。序列化为 `{ positions: number[], normals: number[], colors: number[], indices: number[] }`。Runner 侧还原为 TypedArray 建 GPU buffer。

### 第一阶段 dirty 缓冲

```typescript
// 主进程 scriptHost.ts 内
interface DirtyBuffer {
  fields: Array<{ roId: number; fieldName: string; value: number[] }>
  camera: { view: number[]; projection: number[] } | null
}

const dirty: DirtyBuffer = { fields: [], camera: null }

// setField 实现（与 v0.1 API 一致）
function setField(roId: number, fieldName: string, value: Float32Array) {
  const ro = roIndex.get(roId)
  if (!ro) throw new Error(`[engine.scene.setField] 未找到 RO id=${roId}`)
  const copy = new Float32Array(value)
  ro.fieldValues.set(fieldName, copy)  // 写主进程权威 RO
  dirty.fields.push({ roId, fieldName, value: Array.from(copy) })
}

// camera.apply 闭包（第一阶段：写 dirty，不直接调 renderer）
camera.apply = () => {
  const view = camera.computeView()
  const projection = camera.computeProjection()
  dirty.camera = {
    view: Array.from(view),
    projection: Array.from(projection),
  }
}

// tick 末 flush
function flushDirty() {
  if (dirty.fields.length === 0 && !dirty.camera) return
  runnerManager.sendToRunner({
    type: 'tick-delta',
    tickCount: engine.time.tickCount,
    dirtyFields: dirty.fields,
    camera: dirty.camera,
  })
  dirty.fields = []
  dirty.camera = null
}
```

### 第一阶段错误处理

```
脚本 onTick 抛错
  ↓ catch
  ├─ console.error('[scriptHost] 脚本 onTick 抛错，停脚本（渲染继续）:', err)
  ├─ scriptStopped = true
  ├─ scriptHooks = {}（清钩子）
  ├─ runnerManager.sendToRunner({ type: 'script-error', message: err.message })
  └─ 渲染继续（Runner 收到 script-error 显示错误态，立方体停在最后状态）
```

与 v0.1 错误隔离语义一致：脚本停了渲染继续，立方体停在最后 tick 推的 modelMatrix（静态画面）。第一阶段不做"意图保留动画继续"（那是第二阶段动画系统的特性）。

### 第一阶段验证标准

1. **场景就绪**：runner:start → 主进程加载 Scene → 推 scene-ready → Runner 编译 + 建资源 → 立方体静态渲染
2. **脚本旋转**：脚本 onTick 调 setField → tick 末推 dirty → Runner 应用 → 立方体旋转（与 v0.1 一致）
3. **错误隔离**：故意拼错方法名 → 主进程 catch → 推 script-error → Runner 错误态 + 立方体停静态 + 渲染继续
4. **reload 恢复**：修复脚本 → runner:reload → 主进程重载 → 立方体恢复旋转
5. **resize**：调整 Runner 窗口 → Runner 本地兜底重算 projection（与 v0.1 一致，不推主进程）

### 第一阶段 DemoGame 脚本

**无需修改**。`scripts/main.js` 保持 v0.1 版本（每 tick 算 modelMatrix 调 setField）。脚本 API 表面不变，只是宿主从 Runner 搬到主进程。

---

## 为什么不用独立子进程/worker_threads？

脚本错误是 JS 异常（try-catch 可捕获），不是进程崩溃。主进程跑脚本足够安全（异常隔离靠 try-catch + 停脚本保渲染），不需要进程级隔离。主进程实现最简单（直接 Node fs 读资产 + setInterval tick），且与现有 IPC 基建（`runner:*` channel、`runnerWindowManager`）天然契合。

未来 native 后端（Vulkan 桌面发布）会用真正的独立线程/进程跑脚本，届时这套主进程逻辑可直接迁移到 native 宿主——IPC 协议层不变，只是传输从 Electron ipcRenderer 换成 native 隔离层。

## 核心数据流

```
┌──────────────────────── 主进程（业务权威）────────────────────────┐
│                                                                  │
│  1. runner:start                                                 │
│     ├─ AssetLoader（Node fs）加载 Scene                          │
│     │  → 得到 graph + RO 元信息 + camera 初始态                   │
│     ├─ 构造 engine 全局对象（scene 镜像 + camera + time）         │
│     ├─ new Function 包裹加载 entryScript → 拿 exports 钩子         │
│     ├─ 调 onInit                                                  │
│     └─ 推「场景就绪」给 Runner（含 pipeline 描述 + 顶点/索引 +     │
│        字段映射 + 初始相机模式，让 Runner 建 GPU 资源 + 初始化动画）│
│                                                                  │
│  2. tick 循环（setInterval 50ms，独立于渲染帧）                    │
│     ├─ engine.time 更新                                          │
│     ├─ 调脚本 onTick(dt)                                          │
│     │  脚本设意图：                                               │
│     │  - engine.ro.setAngularVelocity(id, [0,1,0])  → 写 dirty 意图│
│     │  - engine.ro.setColor(id, [1,0,0])            → 写 dirty 值  │
│     │  - engine.camera.mode = 'orbit'               → 写 dirty 相机│
│     │  - engine.camera.setOrbitParams({distance:5}) → 写 dirty 相机│
│     ├─ tick 末：批量推 dirty 给 Runner（一次 IPC）                 │
│     │  payload: {                                                 │
│     │    intentChanges: [{roId, component, params}],  // 动画意图   │
│     │    valueChanges: [{roId, fieldName, value}],    // 非动画值   │
│     │    cameraChanges: {mode?, params?},             // 相机参数   │
│     │  }                                                          │
│     └─ 清空 dirty 缓冲                                            │
│                                                                  │
│  3. 脚本抛错 → catch → 停脚本（清钩子）+ 状态 error                │
│     → 推 error 事件给 Runner（Runner 显示错误态，渲染继续）        │
│                                                                  │
│  4. 输入事件（仅非 FPS 敏感）：                                    │
│     Runner 采集键盘 → IPC 推主进程 → 派发脚本 onKey                │
│     （鼠标控相机走前端本地，不进 IPC）                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                              ↓ IPC（runner:apply-frame）
┌──────────────────────── Runner 渲染进程（渲染 + 动画 + 本地输入）──┐
│                                                                  │
│  1. 收「场景就绪」                                                │
│     ├─ 用 pipeline 描述编译 GPU pipeline                          │
│     ├─ 用顶点/索引数据建 GPU buffer                               │
│     ├─ 建 UniformBuffer（per-RO per-pipeline + global）           │
│     ├─ 初始化动画组件（按初始意图）                                │
│     ├─ 初始化相机控制器（按 mode + 参数）                          │
│     └─ 进入渲染循环（rAF）                                        │
│                                                                  │
│  2. 渲染循环（rAF，独立于 tick）                                   │
│     每 frame：                                                    │
│     ├─ 收主进程推的 dirty（异步，非每帧）：                         │
│     │  - intentChanges → 更新动画组件参数                          │
│     │  - valueChanges → 直接写 RO.fieldValues                      │
│     │  - cameraChanges → 更新相机控制器 mode/参数                   │
│     ├─ 动画组件 tick（本地帧 dt）：                                 │
│     │  - Rotation 组件：modelMatrix = rotMatrix(angularVel × dt)   │
│     │  - Tween 组件：modelMatrix = lerp(from, to, t/duration)      │
│     │  → 写 RO.fieldValues['modelMatrix']                          │
│     ├─ 相机控制器 tick（本地帧 dt + 本地鼠标输入）：                │
│     │  - orbit 模式：按鼠标 drag 更新 azimuth/elevation            │
│     │  - 算 view = lookAt(orbit position, target, up)              │
│     │  - 算 projection = perspective(fov, aspect, near, far)       │
│     │  → renderer.setView/setProjection                            │
│     ├─ renderer.renderGraph(graph, scene)                         │
│     └─ frameCount++                                               │
│                                                                  │
│  3. 输入采集（分流）                                              │
│     ├─ 鼠标（控相机）：canvas.addEventListener 本地处理             │
│     │  → 喂给相机控制器（不经 IPC）                                │
│     ├─ 键盘（脚本逻辑）：canvas.addEventListener → IPC 推主进程    │
│     │  → 主进程派发 onKey → 脚本设意图                             │
│     └─ resize：ResizeObserver → IPC 推主进程 + 本地 canvas 重算    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Scene 加载（主进程侧）

主进程复用 `@liteweave/engine` 的 `AssetLoader`，注入 **Node fs 适配器**（不走 IPC）：

```typescript
// desktop/src/scriptHost.ts（新文件）
import { AssetLoader, createAssetTypeRegistry, registerBuiltinLoaders } from '@liteweave/engine'
import fs from 'node:fs/promises'
import path from 'node:path'

const fsAdapter: FileSystemAdapter = {
  async readText(relativePath) {
    const abs = path.resolve(projectRoot, relativePath)
    const rel = path.relative(projectRoot, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`path escapes project root: ${relativePath}`)
    }
    return fs.readFile(abs, 'utf8')
  },
  async readBytes(relativePath) {
    const abs = path.resolve(projectRoot, relativePath)
    return (await fs.readFile(abs)).buffer
  },
}

const registry = createAssetTypeRegistry()
registerBuiltinLoaders(registry)
const loader = new AssetLoader({ projectRoot, namespaces, defaultNamespace, fs: fsAdapter, registry, manifest })
const scene = await loader.loadAsset<Scene>('demogame:scenes/main.scene.json')
```

主进程持 `scene` 对象作为业务权威。**主进程不创建 GPU 资源**（无 device），只持描述对象（Pipeline/Model/Material 数据），推给 Runner 建资源。

## 动画系统（前端 Runner 侧）

### 组件模型（v0.2 最小闭环：Rotation 组件）

动画组件是前端的**帧级计算器**，每个组件绑定到一个 RO 的某个字段，每帧根据意图算实际值。

```typescript
// engine/src/animation/types.ts（新增）
export interface AnimationComponent {
  /** 组件类型名（如 'rotation'） */
  type: string
  /** 绑定的 RO id */
  roId: number
  /** 绑定的字段名（如 'modelMatrix'） */
  fieldName: string
  /** 每帧更新（由 Runner 渲染循环调用） */
  update(dt: number, ro: RenderObject): void
  /** 销毁（RO 释放或组件移除时） */
  dispose?(): void
}

// engine/src/animation/RotationComponent.ts（新增）
export class RotationComponent implements AnimationComponent {
  type = 'rotation'
  constructor(
    public roId: number,
    public fieldName: string,
    private angularVelocity: [number, number, number],  // rad/s
    private currentAngle: [number, number, number] = [0, 0, 0],
  ) {}

  update(dt: number, ro: RenderObject) {
    this.currentAngle[0] += this.angularVelocity[0] * dt
    this.currentAngle[1] += this.angularVelocity[1] * dt
    this.currentAngle[2] += this.angularVelocity[2] * dt
    // 算绕 XYZ 轴的合成旋转矩阵（列主序）
    const m = computeRotationMatrix(this.currentAngle)
    ro.fieldValues.set(this.fieldName, m)
  }
}
```

### 组件管理器（Runner 侧）

```typescript
// Runner 渲染循环内
const animationComponents = new Map<number, AnimationComponent[]>()  // roId → components

// 收到意图变更（IPC tick-delta）
function applyIntentChange(change: { roId: number; component: string; params: any }) {
  if (change.component === 'rotation') {
    // 移除旧 rotation 组件（同字段同类型只保留一个）
    removeComponent(change.roId, 'rotation', change.params.fieldName ?? 'modelMatrix')
    const comp = new RotationComponent(change.roId, change.params.fieldName ?? 'modelMatrix', change.params.angularVelocity)
    if (!animationComponents.has(change.roId)) animationComponents.set(change.roId, [])
    animationComponents.get(change.roId)!.push(comp)
  }
}

// 渲染循环每帧
function frame(dt: number) {
  for (const components of animationComponents.values()) {
    const ro = roIndex.get(components[0].roId)
    if (ro) for (const comp of components) comp.update(dt, ro)
  }
  // ... 相机控制器 tick ...
  renderer.renderGraph(graph, scene)
}
```

### 未来扩展：插值即组件（CSS transition 模型）

用户方向："先做固定组件，后续改为'插值'本身是组件，类似 CSS 的 transition，绑定到某项属性上"。

未来架构：
```typescript
// 脚本设目标值（不关心怎么到目标）
engine.ro.setTarget(roId, 'modelMatrix', targetMatrix, { duration: 1.0, easing: 'easeInOut' })

// 引擎自动绑定 TransitionComponent 到该字段
// TransitionComponent 每帧 lerp(from, to, t/duration) 算实际值
```

v0.2 先做固定 Rotation 组件，TransitionComponent 后续补。组件接口已预留（`AnimationComponent` 抽象），扩展无需改架构。

## 相机控制器（前端 Runner 侧）

### 内置模式（v0.2 最小闭环：orbit + static）

```typescript
// engine/src/camera/types.ts（新增）
export type CameraMode = 'static' | 'orbit' | 'fps' | 'follow'

export interface CameraControllerParams {
  // 通用
  target?: [number, number, number]      // 观察目标点
  // orbit 模式
  distance?: number                       // 距目标距离
  azimuth?: number                        // 水平方位角（弧度）
  elevation?: number                      // 俯仰角（弧度）
  // fps 模式（占位）
  position?: [number, number, number]
  yaw?: number
  pitch?: number
  // follow 模式（占位）
  followRoId?: number
  followOffset?: [number, number, number]
}

// engine/src/camera/CameraController.ts（新增）
export class CameraController {
  mode: CameraMode = 'static'
  params: CameraControllerParams = {}
  // 鼠标输入状态（本地，不经 IPC）
  private mouseDelta = { x: 0, y: 0 }

  constructor(
    private renderer: Renderer,
    private canvas: HTMLCanvasElement,
    initialCamera: Camera,  // 从 scene.camera 初始化
  ) {
    this.bindMouseInput()
    this.applyToRenderer()
  }

  setMode(mode: CameraMode, params: CameraControllerParams) {
    this.mode = mode
    this.params = { ...this.params, ...params }
  }

  /** 每帧调（渲染循环内） */
  update(dt: number, aspect: number) {
    switch (this.mode) {
      case 'static':
        // 静态相机：用 params 算一次（不响应鼠标）
        break
      case 'orbit':
        // 鼠标 drag 更新 azimuth/elevation
        this.params.azimuth! -= this.mouseDelta.x * 0.01
        this.params.elevation! += this.mouseDelta.y * 0.01
        this.mouseDelta = { x: 0, y: 0 }
        break
      // fps/follow 占位
    }
    this.applyToRenderer()
  }

  private applyToRenderer() {
    const { view, projection } = this.computeMatrices()
    this.renderer.setView(view)
    this.renderer.setProjection(projection)
  }

  private bindMouseInput() {
    // 鼠标输入本地处理，不进 IPC
    this.canvas.addEventListener('mousedown', (e) => { /* ... */ })
    this.canvas.addEventListener('mousemove', (e) => { /* ... */ })
    this.canvas.addEventListener('mouseup', (e) => { /* ... */ })
    this.canvas.addEventListener('wheel', (e) => { /* ... */ })
  }

  private computeMatrices(): { view: Float32Array; projection: Float32Array } {
    // 按 mode + params 算 view/projection
  }
}
```

### 鼠标输入分流

| 输入类型 | 处理位置 | 用途 |
|---|---|---|
| 鼠标移动/拖拽/滚轮 | **前端本地**（CameraController 内） | 控相机（orbit azimuth/elevation、fps yaw/pitch） |
| 键盘按键 | **IPC 推主进程** → 脚本 onKey | 脚本逻辑（如 WASD 移动、空格触发事件） |
| canvas resize | **IPC 推主进程** + 本地重算 | 脚本 onResize + 本地 aspect 更新 |

**为什么鼠标不推主进程？** FPS 敏感（鼠标高频移动），50ms tick 延迟会导致明显卡顿。鼠标控相机是"渲染层"职责（视角调整不改变业务状态），前端本地处理即可。键盘是"业务层"输入（改变脚本状态），走 IPC。

## `engine` 全局 API（v0.2）

```typescript
declare global {
  const engine: {
    // RO 操作（意图 + 值）
    ro: {
      // 查询（与 v0.1 一致）
      find(pipelineId: string): { id: number; modelId: string; materialId: string } | null
      list(): { id: number; modelId: string; materialId: string }[]

      // 动画意图（设组件参数，前端每帧插值）
      setAngularVelocity(roId: number, radPerSec: [number, number, number], fieldName?: string): void
      // 未来：setTarget(roId, fieldName, target, { duration, easing }): void

      // 非动画字段（tick 设值，前端直接应用）
      setField(roId: number, fieldName: string, value: Float32Array): void  // 颜色、可见性等
      getField(roId: number, fieldName: string): Float32Array | undefined
    }

    // 相机（设模式 + 参数，前端本地控制器算矩阵）
    camera: {
      mode: CameraMode                                      // 'static' | 'orbit' | 'fps' | 'follow'
      setMode(mode: CameraMode, params?: CameraControllerParams): void
      setParams(params: Partial<CameraControllerParams>): void
      // 相机参数（脚本可读可写；鼠标在前端改这些值时不同步回主进程——主进程只信脚本设的）
      params: CameraControllerParams
    }

    time: { elapsed: number; delta: number; tickCount: number }
    canvas: { width: number; height: number; aspect: number }  // 由 Runner 推 resize 同步
    log(...args: unknown[]): void

    // 输入事件（键盘，鼠标不进 IPC）
    input: {
      onKey(cb: (e: { action: 'down' | 'up'; key: string; modifiers: { shift: boolean; ctrl: boolean; alt: boolean } }) => void): () => void
    }
  }
}
```

**Camera 不再有 apply()**：v0.1 的 `camera.apply()` 是"脚本算矩阵同步给 renderer"，v0.2 矩阵由前端控制器算，脚本只设 mode + 参数。`setMode`/`setParams` 写 dirty 缓冲，tick 末推给前端控制器。

## dirty 缓冲设计（三类）

```typescript
// 主进程 scriptHost.ts 内
interface DirtyBuffer {
  intentChanges: Array<{ roId: number; component: string; params: any }>  // 动画意图
  valueChanges: Array<{ roId: number; fieldName: string; value: number[] }>  // 非动画值
  cameraChanges: { mode?: CameraMode; params?: Partial<CameraControllerParams> } | null  // 相机参数
}

const dirty: DirtyBuffer = { intentChanges: [], valueChanges: [], cameraChanges: null }

// setAngularVelocity 实现
function setAngularVelocity(roId: number, angularVelocity: [number, number, number], fieldName = 'modelMatrix') {
  // 主进程不持动画组件（前端持），只记意图变更
  dirty.intentChanges.push({ roId, component: 'rotation', params: { angularVelocity, fieldName } })
}

// setField 实现（非动画字段）
function setField(roId: number, fieldName: string, value: Float32Array) {
  const ro = roIndex.get(roId)
  if (!ro) throw new Error(`[engine.ro.setField] 未找到 RO id=${roId}`)
  const copy = new Float32Array(value)
  ro.fieldValues.set(fieldName, copy)  // 写主进程权威 RO（getField 读这个）
  dirty.valueChanges.push({ roId, fieldName, value: Array.from(copy) })
}

// setMode 实现
function setMode(mode: CameraMode, params?: CameraControllerParams) {
  cameraState.mode = mode
  if (params) Object.assign(cameraState.params, params)
  dirty.cameraChanges = { mode, params }
}

// tick 末 flush
function flushDirty() {
  if (dirty.intentChanges.length === 0 && dirty.valueChanges.length === 0 && !dirty.cameraChanges) return
  runnerManager.sendToRunner({
    type: 'tick-delta',
    tickCount: engine.time.tickCount,
    intentChanges: dirty.intentChanges,
    valueChanges: dirty.valueChanges,
    cameraChanges: dirty.cameraChanges,
  })
  dirty.intentChanges = []
  dirty.valueChanges = []
  dirty.cameraChanges = null
}
```

## IPC 协议清单（v0.2）

### 主进程 → Runner（经 `runnerManager.sendToRunner`，走 `runner:event` channel）

| type | 时机 | payload | Runner 动作 |
|---|---|---|---|
| `scene-ready` | start 后一次性 | `{ graph, renderObjects, camera: { mode, params }, canvasSize }` | 编译 pipeline + 建 GPU 资源 + 初始化动画组件 + 初始化相机控制器 + 进渲染循环 |
| `tick-delta` | 每 tick 末 | `{ tickCount, intentChanges, valueChanges, cameraChanges }` | intentChanges → 更新动画组件；valueChanges → 写 RO.fieldValues；cameraChanges → 更新相机控制器 |
| `script-error` | 脚本抛错 | `{ message }` | 显示错误态，渲染继续（动画组件保留最后意图继续插值） |
| `reload` | runner:reload | `{}` | 清错误态 + 重置动画组件 + 等新 scene-ready/tick-delta |
| `stop` | runner:stop | `{}` | 停渲染循环 + 释放 GPU 资源 + 销毁动画组件 + 销毁相机控制器 |

### Runner → 主进程（经 `bridge.invoke`，走 `runner:*` IPC channel）

| channel | 时机 | payload | 主进程动作 |
|---|---|---|---|
| `runner:ready` | Runner WebGPU 就绪 | `{ gpuReady, gpuInfo }` | markReady；推 scene-ready |
| `runner:input-event` | Runner 采集键盘/resize | `{ type: 'keyboard'/'resize', ... }` | 派发给脚本 onKey/onResize |
| `runner:heartbeat` | 每 2s | `{ seq }` | 转发给 IDE 显示 |
| `runner:console` | Runner 主动日志 | `{ level, message }` | 转发给 IDE 控制台 |

**注意**：鼠标输入**不进** `runner:input-event`（前端本地处理）。

## 错误处理

```
脚本 onTick 抛错
  ↓ catch
  ├─ console.error('[scriptHost] 脚本 onTick 抛错，停脚本（渲染继续）:', err)
  ├─ scriptStopped = true
  ├─ scriptHooks = {}（清钩子，不再调 onTick/onResize/onKey）
  ├─ runnerManager.sendToRunner({ type: 'script-error', message: err.message })
  └─ 渲染继续
```

Runner 收到 `script-error`：
- 显示错误态（左下角红色 error 胶囊 + 面板错误行）
- **不停渲染循环**
- **动画组件保留最后意图继续插值**（立方体继续按最后角速度旋转，而非停在静态画面——这是 v0.2 相对 v0.1 的改进：意图模型下脚本停了动画继续）
- 相机控制器保留最后 mode + 参数继续工作
- 不再期待新 tick-delta

**reload 恢复**：
- `runner:reload` → 主进程重新加载脚本 → 推 reload 给 Runner → Runner 清错误态
- 脚本 onInit 重新设意图 → tick-delta 推给 Runner → 动画组件更新

## DemoGame 脚本迁移示例

v0.1（每 tick 算矩阵推值）：
```javascript
exports.onTick = function(dt) {
  elapsed += dt
  const c = Math.cos(elapsed), s = Math.sin(elapsed)
  engine.scene.setField(cubeRoId, 'modelMatrix', new Float32Array([
    c, 0, -s, 0,  0, 1, 0, 0,  s, 0, c, 0,  0, 0, 0, 1
  ]))
}
```

v0.2（设意图，前端插值）：
```javascript
exports.onInit = function() {
  const ro = engine.ro.find('demogame:pipelines/cube-opaque.pipeline.json')
  cubeRoId = ro.id
  // 设角速度，前端 Rotation 组件每帧算矩阵
  engine.ro.setAngularVelocity(cubeRoId, [0, 1, 0])  // 绕 Y 轴 1 rad/s
}
exports.onTick = function(dt) {
  // 不需要每 tick 算矩阵——意图已在 onInit 设好
  // 这里可改意图（如按键加速旋转）
}
```

**改进**：
- 脚本更简洁（声明意图 vs 每帧计算）
- 动画更流畅（帧级插值 vs tick 级 50ms 步进）
- 脚本停了动画继续（意图保留 vs 矩阵不再更新）

## Runner 改造范围

**删除**：
- AssetLoader 集成 / Scene 加载 / engine 对象 / 脚本加载 / tick 循环 / Camera 实例 + apply 闭包 / onTick 调用

**保留**：
- WebGPU 设备初始化 / canvas 配置 + ResizeObserver / Renderer 实例 / 渲染循环（rAF） / 状态卡片 UI

**新增**：
- 动画组件管理器（`animationComponents` Map + 收 intentChanges 更新组件 + 每帧 update）
- 相机控制器（CameraController 类 + 鼠标本地绑定 + 每帧 update）
- `bridge.onEvent` 处理 `scene-ready` / `tick-delta` / `script-error` / `reload` / `stop`
- 键盘输入采集 → `bridge.invoke('runner:input-event', { type: 'keyboard', ... })`

## 主进程新增模块

### `desktop/src/scriptHost.ts`（新文件）

脚本宿主核心：
- `startScriptHost(bootstrap, runnerManager)` —— 加载 Scene + 构造 engine + 加载脚本 + 启 tick
- `stopScriptHost()` —— 停 tick + 清钩子 + 推 stop
- `reloadScript()` —— 重新加载脚本 + 推 reload
- `handleInputEvent(event)` —— 派发给脚本 onKey/onResize
- dirty 缓冲（三类）+ flushDirty

### `engine/src/animation/`（新目录）

- `types.ts` —— AnimationComponent 接口
- `RotationComponent.ts` —— v0.2 最小闭环组件
- `AnimationManager.ts` —— 组件管理器（Runner 侧用）

### `engine/src/camera/`（新目录）

- `types.ts` —— CameraMode / CameraControllerParams
- `CameraController.ts` —— 内置模式控制器（orbit/static 实现，fps/follow 占位）

### `desktop/src/main.js` 调整

- `runner:start` → 调 `scriptHost.startScriptHost`
- `runner:reload` → 调 `scriptHost.reloadScript`
- `runner:stop` → 调 `scriptHost.stopScriptHost` + `runnerManager.stop`
- `runner:ready` → 通知 scriptHost 推 scene-ready
- `runner:input-event`（新）→ 调 `scriptHost.handleInputEvent`

## 与 v0.1（`script-system.md`）的关系

v0.2 是 v0.1 的**架构演进**：
- **脚本 API 调整**：`engine.scene.setField` → `engine.ro.setField`（非动画）+ `engine.ro.setAngularVelocity`（动画意图）；`engine.camera.apply()` 移除，改 `engine.camera.setMode/setParams`
- **DemoGame main.js 需改写**（从每 tick 算矩阵改为 onInit 设角速度）
- **错误隔离语义增强**：脚本停了动画继续（意图保留），v0.1 是停在静态画面
- **生命周期钩子**：onInit/onTick/onResize/onDispose 保留；新增 onKey（键盘输入）

`script-system.md` 保留作为 v0.1 历史文档，本文档是 v0.2 当前架构。

## 最小闭环验证标准

迁移完成后端到端验证：
1. **场景就绪**：runner:start → 主进程加载 Scene → 推 scene-ready → Runner 编译 pipeline + 建资源 + 初始化 → 立方体静态渲染
2. **意图旋转**：脚本 onInit 调 `setAngularVelocity` → tick-delta 推意图 → Runner Rotation 组件每帧算矩阵 → 立方体流畅旋转（帧级平滑，非 50ms 步进）
3. **错误隔离**：故意拼错 `engine.ro.setAngularVelocityXXX` → 主进程 catch → 推 script-error → Runner 显示错误态 + **立方体继续按最后角速度旋转**（意图保留）+ 渲染循环继续
4. **reload 恢复**：修复脚本 → runner:reload → 主进程重载 → 立方体恢复旋转
5. **相机 orbit**：脚本 `engine.camera.setMode('orbit', {distance:5, target:[0,0,0]})` → 鼠标拖拽 Runner 窗口 → 相机绕目标旋转（前端本地处理，无 IPC 延迟）
6. **resize**：调整 Runner 窗口 → Runner 推 resize → 主进程 onResize → aspect 同步 → 前端相机控制器重算 projection
7. **键盘输入**：脚本 `engine.input.onKey(e => ...)` → Runner 按键 → IPC 推主进程 → 脚本回调 → 改角速度 → 旋转方向变化

## 未来扩展（不在本次范围）

- **TransitionComponent**：插值即组件（CSS transition 模型），脚本设目标值 + duration/easing，组件自动 lerp
- **更多动画组件**：Translation（线性速度）、Scale（缩放速度）、Tween（目标 + 时间）
- **fps/follow 相机模式**：第一人称 / 跟随 RO
- **require 支持**：项目内相对路径 require + 白名单三方件
- **多脚本 + 跨脚本状态**：内存数据库托管
- **物理引擎**：主进程集成物理，脚本 onTick 改物理状态，物理引擎算变换推意图
- **native 后端迁移**：主进程逻辑搬 native 宿主，IPC 协议层不变
