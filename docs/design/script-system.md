# 脚本系统设计（v0.1）

## 定位

LiteWeave 的脚本层是**决策层**，不是计算层。脚本只响应事件改状态，不参与渲染/物理计算本身。渲染和物理由引擎 native 层（Renderer/物理引擎）负责，脚本通过事件钩子驱动状态变更。

## 核心架构

```
┌─────────────────────────────────────────────┐
│  Tick Loop（setInterval，可配置，默认 50ms）  │
│  1. engine.time 更新                         │
│  2. 事件派发 → 脚本 onTick(dt)                │
│  3. 脚本响应事件改状态（RO 字段/Camera）       │
│  ── 脚本抛错 → 停脚本 + 渲染继续 ──           │
└─────────────────────────────────────────────┘
                    ↓ 状态累积
┌─────────────────────────────────────────────┐
│  Render Loop（rAF，独立于 tick）              │
│  1. resize 检查 → onResize(w,h)              │
│  2. renderer.resize()                        │
│  3. renderer.renderGraph(graph, scene)       │
│     读 RO.fieldValues + view/projection 矩阵 │
└─────────────────────────────────────────────┘
```

**关键分离**：
- **Tick ≠ 渲染帧**：tick 是固定步长（默认 50ms = 20Hz），渲染是 rAF（独立频率）
- **脚本只响应事件**：不在脚本里做渲染/物理计算，只改状态
- **错误隔离**：脚本抛错停脚本，渲染继续静态画面

## 脚本入口

### project.json 配置

```json
{
  "entry": "demogame:scenes/main.scene.json",
  "entryScript": "scripts/main.js",
  "settings": {
    "tickRate": 50
  }
}
```

- `entry`：入口场景资产 id（已有）
- `entryScript`：入口脚本相对路径（相对项目根；脚本不是资产，不走 AssetLoader）
- `settings.tickRate`：tick 间隔毫秒数，缺省 50ms

### 脚本模块格式

CommonJS 模块，导出生命周期钩子：

```javascript
// scripts/main.js
let cubeRoId = -1
let elapsed = 0

exports.onInit = function() {
  const ro = engine.scene.findRenderObject('demogame:pipelines/cube-opaque.pipeline.json')
  if (ro) cubeRoId = ro.id
  engine.log('脚本已加载')
}

exports.onTick = function(dt) {
  if (cubeRoId < 0) return
  elapsed += dt
  const c = Math.cos(elapsed), s = Math.sin(elapsed)
  engine.scene.setField(cubeRoId, 'modelMatrix', new Float32Array([
    c, 0, -s, 0,  0, 1, 0, 0,  s, 0, c, 0,  0, 0, 0, 1
  ]))
}

exports.onResize = function(w, h) {
  engine.camera.aspect = w / h
  engine.camera.apply()
}

exports.onDispose = function() {
  engine.log('脚本已卸载')
}
```

## `engine` 全局 API（函数式）

```typescript
declare global {
  const engine: {
    scene: {
      // 找 RO（按 material.pipelineBindings key 筛），返回元信息
      findRenderObject(pipelineId: string): { id: number; modelId: string; materialId: string } | null
      // 列出所有 RO 元信息
      listRenderObjects(): { id: number; modelId: string; materialId: string }[]
      // 按 RO 内部 id 改字段（经 RO.pipelineBindings 映射到 shader uniform）
      setField(roId: number, fieldName: string, value: Float32Array): void
      // 按 RO 内部 id 读字段当前值（返回拷贝，修改不影响内部）
      getField(roId: number, fieldName: string): Float32Array | undefined
    }
    camera: Camera  // 引擎层 Camera 实例引用，直接改字段后调 .apply()
    time: { elapsed: number; delta: number; tickCount: number }
    canvas: { width: number; height: number; aspect: number }
    log(...args: unknown[]): void
  }

  interface Camera {
    type: 'perspective' | 'orthographic'
    position: [number, number, number]
    target: [number, number, number]
    up: [number, number, number]
    fov: number
    near: number
    far: number
    aspect?: number
    computeView(): Float32Array
    computeProjection(): Float32Array
    // 改完字段后调 apply()，引擎同步 view+projection 矩阵给 Renderer
    apply(): void
  }
}
```

### 设计要点

**函数式 API（纯 id）**：
- `engine.scene.setField(roId, name, value)` 而非 `handle.setField(name, value)`
- RO 用内部 id（number）索引，脚本不持 RO 对象引用
- 未来跨进程时，id 可序列化走 IPC，API 不变

**Camera 显式 apply**：
- 脚本改 `engine.camera.position` 等字段后，必须调 `engine.camera.apply()` 同步矩阵给 Renderer
- 为什么不自动同步：脚本可能连续改多个字段（position + target），自动同步会重算多次；显式 apply 让脚本控制同步时机
- `apply()` 内部调 `renderer.setView(this.computeView())` + `renderer.setProjection(this.computeProjection())`
- Camera 类本身不持 Renderer 引用（保持纯业务对象），apply 由 Runner 创建时注入闭包

**闭包变量存状态**：
- 脚本模块作用域里的 `let` 变量（如 `let elapsed = 0`）跨 tick 保持
- 跨脚本生命周期的状态（如场景切换后保留）未来由内存数据库托管，这次不做

## 生命周期钩子

| 钩子 | 调用时机 | 用途 |
|------|---------|------|
| `onInit()` | 脚本加载后、首 tick 前 | 拿 RO id、初始化状态 |
| `onTick(dt)` | 每个 tick（默认 50ms） | 推状态、改 RO 字段、改 Camera |
| `onResize(w, h)` | canvas 尺寸变化时 | 重算 aspect、调 camera.apply() |
| `onDispose()` | 脚本卸载时（场景切换/窗口关闭） | 清理资源 |

`dt` 单位是秒（`tickMs / 1000`）。

## 帧时序

```
Tick Loop（setInterval(tickRate)）：
  1. engine.time.delta = tickRate / 1000
  2. engine.time.elapsed += delta
  3. engine.time.tickCount++
  4. 脚本 onTick(delta) 调用（try/catch）
     - 脚本调 engine.scene.setField() 改 RO 字段
     - 脚本改 engine.camera 后调 engine.camera.apply()
     - onTick 抛错 → catch → 停脚本 → console 报错 → 状态置 error

Render Loop（rAF）：
  1. resize 检查（仅尺寸变化时）→ 脚本 onResize(w,h)（try/catch，仅脚本未停时）
  2. renderer.resize(w, h)
  3. renderer.renderGraph(graph, scene)
     - 读 RO.fieldValues（脚本上次 onTick 改的值）
     - 读 view/projection 矩阵（脚本上次 camera.apply() 同步的值）
```

**关键**：tick 和渲染解耦。脚本改的状态在下次 renderGraph 时被读取。脚本出错只停脚本，渲染继续（静态画面 = 最后一次 onTick 后的状态）。

## 错误处理

### 脚本加载失败（语法错/顶层抛错）
- console 报错 + `state.error = "脚本加载失败: ..."`
- 不进 tick 循环
- 渲染继续（静态画面，无脚本驱动）

### onTick/onResize 抛错
- console 报错 + `state.error = "脚本运行时错误: ..."`
- 停脚本：清空所有钩子（onTick/onResize/onDispose 都不再调）
- 渲染继续（静态画面）
- **不调 onDispose**（脚本异常退出，非正常卸载）

### 脚本正常卸载（场景切换/窗口关闭）
- 调 `onDispose()` 一次（try/catch，抛错也忽略）
- 清空钩子

### ErrorScene（后续做，这次不实现）
- 内置错误场景（不挂脚本）
- 脚本出错时切换到 ErrorScene 渲染错误信息 overlay
- 这次用 console 报错 + Runner UI 卡片显示错误状态兜底

## 脚本加载与隔离

### 加载流程
1. Runner 经 IPC 读脚本文件文本（`runner:read-script` channel，payload: `{ projectRoot, relativePath }`）
2. 用 `new Function('engine', 'exports', 'require', scriptText)` 包裹执行
   - `engine`：注入的全局 API 对象
   - `exports`：CommonJS 导出对象（拿 onInit/onTick/onResize/onDispose）
   - `require`：受限 require（见下）
3. 执行时 try/catch：顶层抛错 → 加载失败 → 状态 error → 无 onInit
4. 拿 `exports.onInit/onTick/onResize/onDispose` 钩子存到 Runner 内部

### require 支持
- **白名单三方件**：`require('gl-matrix')` 等内置模块（Runner 预先 bundle 或从 engine workspace 引入）
- **项目内相对路径**：`require('./utils.js')` 相对脚本文件目录解析（后续做，这次留接口不实现）
- **禁止**：`require('fs')` / `require('child_process')` 等 Node 内置模块（安全隔离）

### 隔离边界
- 脚本跑在 Runner 进程同 V8 堆（无进程隔离，无 IPC 开销）
- 脚本通过 `engine` 全局对象访问引擎能力，不能直接拿 Renderer/Scene 内部对象
- 脚本抛错不影响渲染循环（catch 隔离）

## Camera.apply() 实现

```typescript
// Runner 创建 Camera 实例后，注入 apply 闭包
const camera = Camera.fromSceneCamera(scene.camera)
camera.apply = () => {
  renderer.setView(camera.computeView())
  renderer.setProjection(camera.computeProjection())
}
// 注入到 engine 全局对象
const engine = { camera, scene: { ... }, ... }
```

Camera 类本身不持 Renderer 引用（保持纯业务对象，未来搬脚本层时不带 Renderer 依赖）。apply 由 Runner 在创建 engine 对象时动态绑定。

## 这次实现的范围（最小闭环）

**做**：
- project.json 加 `entryScript` + `settings.tickRate` 字段
- IPC channel `runner:read-script`（读脚本文件文本）
- 脚本加载器（`new Function` 包裹 + 顶层 try/catch）
- `engine` 全局对象（scene.setField/getField/findRenderObject + camera + time + canvas + log）
- Camera.apply() 注入
- Tick 循环（setInterval，仅 onTick 钩子，try/catch 停脚本）
- 错误处理（加载失败 + onTick 抛错 → 停脚本 + 渲染继续）
- DemoGame `scripts/main.js`（立方体绕 Y 轴旋转）
- 端到端验证（动态旋转画面）

**不做（后续补）**：
- onInit / onResize / onDispose 钩子（这次只 onTick）
- require 白名单 + 项目内 require（这次脚本不依赖 require，手写矩阵）
- ErrorScene
- 跨脚本生命周期的内存数据库
- 脚本热重载

## 验证脚本

`scripts/main.js`（DemoGame）：
```javascript
let cubeRoId = -1
let elapsed = 0

exports.onTick = function(dt) {
  if (cubeRoId < 0) {
    const ro = engine.scene.findRenderObject('demogame:pipelines/cube-opaque.pipeline.json')
    if (ro) cubeRoId = ro.id
    else return
  }
  elapsed += dt
  const c = Math.cos(elapsed), s = Math.sin(elapsed)
  engine.scene.setField(cubeRoId, 'modelMatrix', new Float32Array([
    c, 0, -s, 0,
    0, 1,  0, 0,
    s, 0,  c, 0,
    0, 0,  0, 1,
  ]))
}
```

注：最小闭环里 onInit 没做，所以 RO 查找放在 onTick 首次调用时（懒初始化）。

## 端到端验证标准

1. Runner 启动后立方体开始绕 Y 轴旋转（动态画面）
2. console 输出脚本加载日志
3. 故意写错脚本（如 `engine.scene.setField` 拼错）→ console 报错 + 立方体停止旋转（静态画面）+ Runner UI 显示 error 状态
4. 修正脚本 → 重载 → 立方体恢复旋转
