# LiteWeave 引擎层推进 TODO

> 状态：会话接力点（2026-10-27）
> 用途：本次会话设计讨论结束，下次会话从此处接力推进实施。
> 关联文档：
> - `docs/design/monaco-tsserver.md`（Monaco + tsserver + 双窗口模型）
> - `docs/design/demo-resource-catalog.md`（demo 资源表 + 实施策略 + Three.js 定位）

---

## 已完成（本次会话）

### 设计文档
- ✅ `docs/design/monaco-tsserver.md`（485 行）—— Monaco + tsserver 集成设计
  - 8 个关键决策（tsserver 主进程子进程、STDIO 协议、磁盘文件模型、inferredProjects、自建 MonacoTsAdapter、`system.code` 资源类型、自动保存、MCP 命令）
  - 5 阶段落地路线
  - 第 10 节"双窗口模型"：IDE 预览 vs Runner 调试（独立 Electron 进程）
- ✅ `docs/design/demo-resource-catalog.md`（395 行）—— Demo 资源表
  - 9 条资源条目（.lang 已实现 / .kv.json / 纹理 / 模型 / 材质 / 管线 / 管线图 / 渲染对象 / Shader）
  - 阶段一静态场景渲染资源集小结 + 渲染运行时链路图
  - 实施策略：先硬编码 demo 跑通 PBR 再反向沉淀字段
  - Three.js 定位：仅 IDE 静态预览工具，不进引擎业务层
  - 测试资源登记：`D:\projects\LearnOpenGL\resources\objects\backpack\`

### 记忆条目（持久化到 auto-memory）
- ✅ `project_engine-web-architecture.md`（修正版）—— 引擎业务层+Web 后端架构 + 双窗口模型
- ✅ `feedback_engine-implement-first-then-protocol.md` —— 先硬编码 demo 再沉淀协议
- ✅ MEMORY.md 索引更新

### 既有 IDE 任务（本次会话完成）
- ✅ 任务 #89 删除保存/全部保存菜单项 + i18n 清理
- ✅ 任务 #90 当前工程自动保存（调研确认：现有架构已实现编辑即落盘）
- ✅ 任务 #91 实现文件菜单下的新建项目（CreateProjectDialog + MenuBar 订阅 CREATE_PROJECT_COMMAND）
- ✅ 任务 #92 删除菜单/工具栏/欢迎页的"新建资源"入口
- ✅ 任务 #93 修复 Explorer 未撑满容器导致空白处右键无效
- ✅ 任务 #94 设计文档：Monaco + tsserver
- ✅ 任务 #95 设计文档补丁：双窗口模型

---

## 待推进 TODO（按优先级排序）

### 优先级 1：Runner 窗口基建（前置，1-2 周）

**为什么前置**：引擎业务层 demo 需要跑在 Runner 里，Runner 链路不通 demo 无处可跑。这是所有后续引擎工作的承载。

**任务**：
- [ ] 主进程：`RunnerWindowManager`（创建/管理 Runner BrowserWindow，生命周期管理）
- [ ] 主进程：Runner IPC channel
  - `runner:start`（载荷：`{ projectRoot, entryScene?, entryScript? }`）
  - `runner:stop`
  - `runner:reload`
  - `runner:status`（Runner → IDE 状态推送）
  - `runner:console`（Runner → IDE 日志转发）
  - `runner:inspect`（IDE → Runner 查询引擎内部状态）
- [ ] Runner 入口：`runner.html` + `runner.ts`（加载项目、跑引擎业务层主循环）
- [ ] IDE 内：工具栏"运行"按钮 + 命令绑定（F5 / `system.runner:start`）
- [ ] IDE 内：Runner 状态指示器（运行中/暂停/退出/异常）
- [ ] IDE 内：Runner 控制台面板（接收 `runner:console` 事件显示日志）
- [ ] MCP 命令：`system.runner:start/stop/reload/status/console/inspect` 注册到 `core.mcpCommands`
- [ ] Runner 进程崩溃恢复：监听 exit 事件 → 通知 IDE → 显示"重启 Runner"按钮
- [ ] 关闭项目时主动关闭 Runner（Runner 不能脱离 IDE 独活）

**参考**：`docs/design/monaco-tsserver.md` 第 10 节（10.4-10.8）

**验收**：F5 一键拉起 Runner 窗口；Runner 崩溃不影响 IDE；关闭项目 Runner 自动关闭；AI 通过 MCP `system.runner:*` 能驱动 Runner。

---

### 优先级 2：引擎业务层 demo（主线，2-3 周）

**目标**：硬编码 backpack PBR 渲染，跑在 Runner 窗口，验证渲染链路 + 反向沉淀资源字段。

**任务**：
- [ ] 新建 `engine` workspace（与 app/server/desktop 平级）
- [ ] 引擎业务层最小实现：
  - [ ] OBJ 解析（用 `obj-file-parser` 或 `webgl-obj-loader` 库，不自己写）
  - [ ] 纹理加载（图片 → WebGPU texture）
  - [ ] 材质构造（PBR 参数 + 5 纹理 slot：diffuse/normal/specular/roughness/ao）
  - [ ] 管线构造（PBR shader + bindings）
  - [ ] 管线图（单管线 → swapchain，最简 DAG）
  - [ ] RenderObject 构造（model + material + transform）
  - [ ] 反向依赖机制（材质声明可见管线 → 入池）
  - [ ] 渲染循环（rAF / fixed timestep）
- [ ] WGSL PBR shader（VS + FS）
- [ ] 最简轨道相机（鼠标旋转 / 滚轮缩放）
- [ ] Runner 入口加载引擎 + 跑 demo
- [ ] 资源路径：硬编码指向 `D:\projects\LearnOpenGL\resources\objects\backpack\`

**参考**：
- `docs/design/demo-resource-catalog.md` 资源 #3-#9（纹理/模型/材质/管线/管线图/渲染对象/Shader）
- `docs/design/demo-resource-catalog.md` "实施策略"章节（先硬编码再沉淀）
- `docs/design/demo-resource-catalog.md` "渲染运行时链路"图

**验收**：Runner 窗口渲染出 backpack 模型；PBR 着色正确（5 张贴图按 slot 绑定）；摄像机可旋转 / 缩放；静态一帧渲染（不做主循环 / 不跑脚本 / 不跑物理）。

**demo 完成后产出**：
- 资源字段草案（从硬编码值反向提炼 .model / .material / .pipeline / .pipeline-graph / .texture 的实际字段结构）
- 这份字段草案写入 `docs/design/engine-layer.md`（待新建）

---

### 优先级 3：Monaco + tsserver 阶段 1（1 周，可与优先级 1-2 并行）

**为什么并行**：Monaco 是脚本编辑基建，与 Runner / 引擎 demo 不互相阻塞；早期落地能让脚本作者尽早有编辑环境。

**任务**：
- [ ] 引入 `monaco-editor` npm 依赖（app workspace）
- [ ] 写 `CodeEditor` 组件，挂载 Monaco，绑定 Monaco language ↔ 文件后缀
- [ ] 接入 `core.editors.register('system.code', CodeEditor)`
- [ ] 资源管理器双击 .ts/.js/.json/.wgsl 打开 CodeEditor 标签
- [ ] 自动保存链路（防抖 300ms → `core.project.writeFile`）
- [ ] 静态检查：Monaco 基础语法高亮可用（无 tsserver）

**参考**：`docs/design/monaco-tsserver.md` 第 4 节阶段 1

**验收**：能在 IDE 内打开 .ts 文件、编辑、看到语法高亮、保存到磁盘。

---

### 优先级 4：IDE 静态预览（Three.js，1 周，可并行）

**目标**：用 Three.js 在 IDE 内做静态预览，看模型/纹理资源长啥样。

**任务**：
- [ ] `app` workspace 装 `three` 依赖
- [ ] 写 `ThreePreviewPanel` 组件，挂载 Three.js scene + camera + renderer
- [ ] 加载 .obj / .gltf / .glb → Three.js Loader → 显示网格
- [ ] 加载纹理 → 显示贴图
- [ ] 轨道相机（Three.js OrbitControls）
- [ ] 注册为 `system.preview` 资源类型编辑器（或新 tab 类型）
- [ ] 资源管理器选中模型文件 → 打开预览标签

**参考**：`docs/design/demo-resource-catalog.md` "Three.js 定位"章节

**验收**：在 IDE 内选中 backpack.obj → 预览面板用 Three.js 渲染出模型 + 5 张贴图。

---

### 优先级 5：从硬编码 demo 沉淀资源协议（demo 完成后）

**任务**：
- [ ] 新建 `docs/design/engine-layer.md`
- [ ] 从 demo 硬编码值反向提炼字段结构：
  - .model（顶点/索引/UV/法线字段）
  - .material（PBR 参数 + 纹理 slot + visiblePipelines 字段）
  - .pipeline（shader 引用 + bindings + render states）
  - .pipeline-graph（nodes + edges + 根节点 swapchain）
  - .texture（路径 + slot 语义）
- [ ] 定义业务层 / 后端接口边界（RenderBackend 等接口）
- [ ] 定义 `engine.d.ts` 脚本 API 契约（engine.set / engine.on / engine.emit 等）
- [ ] 定义 `renderSceneOnce(scene, canvas)` API（IDE 预览用）
- [ ] 定义 `run(config): Runner` API（Runner 用）

---

### 优先级 6：Monaco + tsserver 阶段 2-3（2 周）

**任务**：
- [ ] 阶段 2：tsserver 子进程接入
  - 主进程 `TsServerManager`（spawn tsserver.js，stdio 通信，生命周期）
  - 主进程 `TypeScriptServiceHost`（IPC 桥接）
  - 渲染进程 `TypeScriptService` 单例
  - `MonacoTsAdapter` 注册 hover/completion/diagnostics provider
- [ ] 阶段 3：完整语言特性
  - definition / references / rename / format / signature help
  - 诊断实时推送
  - 跨文件类型解析
  - MCP 命令 `system.code:*`

**参考**：`docs/design/monaco-tsserver.md` 第 4 节阶段 2-3

---

## 暂不推进（待后续阶段）

- 动画 / 骨骼系统
- 物理（最简版除外）
- 脚本运行时 API（vm.Context 沙箱）
- .scene 资源协议（demo 阶段硬编码，不做资源加载）
- 输入事件系统
- 音频
- WGSL LSP（`wgsl-analyzer` 集成）
- Vulkan 后端（业务层稳定后再写）
- WebGL/WebGPU 后端切换（Canvas2D 跑通后再升级）

---

## 关键架构原则（不要忘记）

1. **业务层一份代码 + 多后端**：引擎业务层与后端解耦，Web 后端是真后端不是 mock
2. **双窗口模型**：IDE 进程只编辑+静态预览（renderSceneOnce），Runner 独立进程跑脚本+主循环
3. **先硬编码 demo 再沉淀协议**：避免纸上推演字段，从工作代码反向提炼
4. **Three.js 仅 IDE 静态预览**：不进引擎业务层，不堵 Vulkan 后端路径
5. **反向依赖**：材质声明可见管线 → 渲染对象入池 → 管线遍历池子 draw
6. **管线图是有向图不是树**：节点=attachment，边=pipeline id，根=swapchain
7. **WGSL 单源**：Web 后端原生 WGSL，Native 后端 Naga 转 SPIR-V
8. **脚本不每帧跑**：脚本只响应事件修改参数，引擎按帧消费参数
9. **KV 数据库纯内存**：运行时不落盘，支持 mod 修改原生功能
10. **自动保存模式**：所有编辑器编辑即落盘，无 Ctrl+S（与既有 LangEditor / ProjectConfigEditor 一致）

---

## 下次会话接力建议

直接从**优先级 1（Runner 窗口基建）**开始实施。理由：
- Runner 是所有引擎工作的承载，不打通后续都跑不起来
- 工作量 1-2 周，相对独立
- 完成后可立即进入优先级 2（引擎业务层 demo）

如果用户改变主意要先看视觉效果，可临时跳到优先级 4（Three.js IDE 预览），1 周内出效果。

如果用户要先做脚本基建，可临时跳到优先级 3（Monaco 阶段 1），1 周内出效果。

但**主线推荐路径仍是 1 → 2 → 5 → 6**。
