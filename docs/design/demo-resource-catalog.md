# Demo 场景资源表（条目累积）

> 状态：累积中（2026-10-27 起）
> 用途：逐条记录 demo 场景需要的资源，最终汇总为 `docs/design/engine-layer.md` 的资源协议字段来源。
> 记录原则：仅记录用户告知的内容，不主动补充字段。

---

## 资源 #1：国际化（.lang，已实现）

- **资源类型**：`.lang`（已落地，见 `experience_lang_resource_lifecycle`）
- **格式**：properties 风格键值对（`key=value`）
- **路径示例**：`assets/<namespace>/i18n/zh_CN.lang`
- **字段**：键值对，key 是字符串 id，value 是翻译文本
- **用途**：游戏文案国际化
- **引用关系**：project.json 的 `languages` 字段声明有哪些语言；脚本通过 i18n key 取翻译
- **现状**：已实现 create/open/edit/save/history/delete 完整生命周期 + 语言联动

---

## 资源 #2：KV 数据库（.kv.json，新增）

- **资源类型**：`.kv.json`（JSON 文件作为 KV 数据库的持久化形态）
- **格式**：JSON 对象（顶层含元数据 + data 两部分，不是裸字典）
- **路径示例**：`assets/<namespace>/data/<name>.kv.json`（待定，等用户后续说明）
- **字段结构**：
  ```json
  {
    "id": "<唯一标识>",
    "name": "<人类可读名>",
    "description": "<描述>",
    "data": {
      // 实际 KV 数据，键值对
    }
  }
  ```
  - 顶层有元数据字段 `id` / `name` / `description`
  - 实际数据放在 `data` 字段内（不是顶层直接铺开）
  - `data` 内部结构待用户后续说明（嵌套对象/扁平 KV/数组等）
- **用途**：各种游戏数据存放（数据驱动）
- **访问方式**：脚本可增删查改（CRUD，针对 `data` 内部）
- **关键属性**：**纯内存数据库**
  - 持久化形态是 JSON 文件（项目资源，含元数据 + data）
  - 运行时加载到内存后，脚本修改的是内存状态，**不落盘**
  - 设计目的：未来 mod 场景——mod 通过修改 KV 内存状态来修改原生功能，不破坏原资源文件
- **引用关系**：（待用户后续说明）
- **生命周期**：
  - 编辑期：作为 JSON 资源在 IDE 内编辑（落盘是 JSON 源文件，含元数据 + data）
  - 运行期：Runner 加载到内存后，脚本 CRUD 仅改内存中的 data，退出 Runner 不回写磁盘

---

## 资源 #3：纹理（.texture / 图片，新增）

- **资源类型**：纹理（图片资源）
- **格式**：图片文件（具体后缀待定，可能是 .png / .texture.json 等）
- **路径示例**：`assets/<namespace>/textures/<name>.<ext>`（待定）
- **字段结构**：（待用户后续说明，是否需要元数据包裹、是否引用外部图片文件等）
- **用途**：渲染用纹理（贴图、精灵、UI 图等）
- **产出方式**：
  - **前期**：通过 Aseprite 或外部工具产出，导入项目作为资源
  - **后期**：内置像素画绘制工具
    - 基本功能即可
    - 目标：达到 AI 可操作的程度
    - 用途：执行前台脚本批量工作（自动化像素画生成/编辑），工作量不大
- **访问方式**：（待用户后续说明，脚本是否能修改纹理 / 仅读取引用）
- **引用关系**：（待用户后续说明，被 .material / .scene / pipeline 节点引用）
- **生命周期**：
  - 编辑期：作为资源在 IDE 内管理（导入/查看/编辑——后期内置像素画工具）
  - 运行期：Runner 加载到 Web 后端纹理上传

---

## 资源 #4：模型（.model，新增）

- **资源类型**：模型（3D 网格数据）
- **格式**：待用户后续说明（自定义 JSON / glTF / 其他）
- **路径示例**：`assets/<namespace>/models/<name>.<ext>`（待定）
- **字段结构**：（待用户后续说明，顶点/索引/UV/法线/骨骼等字段）
- **用途**：3D 网格数据，渲染三要素之一（模型 + 材质 + 纹理）
- **产出方式**：（待用户后续说明，前期外部工具导入还是内置工具）
- **访问方式**：（待用户后续说明，脚本是否可修改）
- **引用关系**：被 .material / .scene / pipeline 节点引用（场景中的实体挂载模型）
- **生命周期**：（待用户后续说明）

---

## 资源 #5：材质（.material，新增）

- **资源类型**：材质（渲染参数集，引用纹理）
- **格式**：待用户后续说明（JSON）
- **路径示例**：`assets/<namespace>/materials/<name>.material`（待定）
- **字段结构**：（待用户后续说明，shading 参数 / uniform 值 / 引用纹理 slot 等）
- **用途**：渲染三要素之一，描述模型如何被绘制（着色参数 + 纹理绑定）
- **访问方式**：（待用户后续说明，脚本是否可改 material 参数）
- **引用关系**：**材质引用纹理**（一个材质可绑定多个纹理 slot：albedo / normal / roughness 等）
- **被引用关系**：被 .scene / pipeline 节点引用，与模型配合渲染
- **生命周期**：（待用户后续说明）

**渲染三要素关系**：
```
模型（.model）  +  材质（.material）  +  纹理（.texture）
   ↓                  ↓                    ↓
  网格数据          着色参数            像素数据
                      └── 引用 ──→ 纹理 slot
   └─────────────── 一起挂到场景实体上 ────────────────→
```

---

## 资源 #6：管线（.pipeline，新增）

- **资源类型**：管线（单次渲染 pass 的描述）
- **格式**：待用户后续说明（JSON）
- **路径示例**：`assets/<namespace>/pipelines/<name>.pipeline`（待定）
- **字段结构**：（待用户后续说明，shader 引用 / 绑定的 attachment / uniform 参数等）
- **用途**：渲染三要素之外的"执行单元"——一次 draw/compute 调用的描述
- **访问方式**：（待用户后续说明，脚本是否可改 pipeline 参数）
- **引用关系**：
  - 引用 shader（.shader.wgsl）
  - 引用 attachment（纹理，作为输入/输出）
- **被引用关系**：被**管线图**作为**边**引用（pipeline id）
- **生命周期**：（待用户后续说明）

---

## 资源 #7：管线图（.pipeline-graph，新增）

- **资源类型**：管线图（描述一次完整渲染如何由多个管线组合完成）
- **格式**：JSON（有向图结构）
- **路径示例**：`assets/<namespace>/pipelines/<name>.graph.json`（待定）
- **字段结构**：
  - **图模型**：**有向图**（不是树）
  - **节点**：attachment（管线之间通讯的纹理，作为节点）
  - **边**：管线 id（一条边 = 一次管线 pass，连接输入 attachment → 输出 attachment）
  - **根节点**：`swapchain`（最终收束点，输出到屏幕）
  - **方向**：从多个叶子节点（输入纹理/资源）→ 中间节点（中间 attachment）→ 收束到根 swapchain
- **示例（待用户后续确认结构）**：
  ```json
  {
    "nodes": [
      { "id": "swapchain", "kind": "output" },
      { "id": "gbuffer_albedo", "kind": "attachment", "texture": "..." },
      { "id": "gbuffer_normal", "kind": "attachment", "texture": "..." },
      ...
    ],
    "edges": [
      { "pipeline": "gbuffer_pass", "from": ["<input resources>"], "to": ["gbuffer_albedo", "gbuffer_normal"] },
      { "pipeline": "lighting_pass", "from": ["gbuffer_albedo", "gbuffer_normal"], "to": ["hdr_color"] },
      { "pipeline": "tone_mapping", "from": ["hdr_color"], "to": ["swapchain"] }
    ]
  }
  ```
- **用途**：
  - 记录一次渲染是怎么完成的——每条管线的输入/输出是什么
  - 框架依据管线图信息**组装出实际的渲染调用序列**（拓扑排序后逐管线执行）
- **关键属性**：
  - 有向图而非树——允许合并（多管线输出到同一 attachment）和分叉（一管线输出多 attachment）
  - 收束到 swapchain 单一终点（屏幕输出）
- **访问方式**：（待用户后续说明，脚本是否可改管线图）
- **引用关系**：
  - 边引用 .pipeline（通过 pipeline id）
  - 节点引用 .texture（attachment 的纹理资源）
- **被引用关系**：被 .scene 引用（场景指定用哪个管线图渲染）
- **生命周期**：（待用户后续说明）

**管线图与管线的关系**：
```
管线（.pipeline）     = 单个 pass 的"怎么画"描述（shader + 绑定）
管线图（.graph）      = 多个 pass 怎么组合完成一次渲染（DAG 拓扑）

  资源 ──→ [管线 A] ──→ attachment ──→ [管线 B] ──→ attachment ──→ [管线 C] ──→ swapchain
                              ↑                                              ↑
                            节点                                            根
                       (管线 A 输出 / 管线 B 输入)                       (屏幕)
```

---

## 资源 #8：渲染对象（RenderObject，运行时内存对象，新增）

- **资源类型**：**运行时内存对象**（不是磁盘资源文件，是引擎运行时构造的对象）
- **形态**：不落盘，由引擎从场景实体 + 资源引用组装而成
- **字段结构**：
  ```typescript
  interface RenderObject {
    model: ModelRef          // 模型引用
    material: MaterialRef    // 材质引用
    transform: Matrix4x4     // 位置矩阵（世界变换）
  }
  ```
- **用途**：渲染三要素（模型+材质+位置）的运行时聚合单元，管线遍历时画的就是它
- **关键属性：反向依赖**
  - 不是"管线主动找渲染对象"，而是"渲染对象主动登记到管线"
  - **材质描述了自己在哪个管线中可见**（材质字段含 `visiblePipelines: PipelineId[]` 或类似机制）
  - 运行时引擎依据**当前激活的管线表**创建 N 个对象池（一个管线一个池）
  - 渲染对象依据**自身的可见性**（材质声明的可见管线列表）将引用**加入对应池**中
- **运行时流程**：
  1. 引擎启动 / 场景激活 → 读取当前激活管线表 → 创建 N 个空的对象池（每管线一个）
  2. 场景中每个 RenderObject 构造时 → 查材质的可见管线列表 → 把自己 push 到对应池
  3. 渲染循环遍历管线图拓扑 → 到某管线时 → 遍历该管线的对象池 → 逐个 draw 到 attachment
- **方向语义**：
  - 正向：场景 → 渲染对象 → 管线（"我要被这个管线画"）
  - 反向：管线 → 渲染对象池 → 渲染（"我现在画池子里这些对象"）
  - 引擎按反向依赖组织——管线被动接收可见对象，不主动查询场景
- **可见性判定**：在材质里声明（不是在渲染对象里，也不是在管线里）
  - 材质字段示例（待用户后续确认）：`{ "visiblePipelines": ["gbuffer_pass", "shadow_pass"] }`
  - 同一渲染对象可在多个管线池中（如既画阴影又画 gbuffer）
- **生命周期**：
  - 创建：场景加载时从实体+组件构造
  - 销毁：场景卸载或实体被删除
  - 修改：脚本运行时增删 RenderObject / 改材质可见性 → 重新入池
- **与磁盘资源的关系**：
  - 不直接对应磁盘文件
  - 间接由 .scene 实体（含 transform）+ 引用的 .model + .material 组装而成
  - .scene 文件描述"场景里有哪些实体 + 各实体的 model/material 引用 + transform"（具体 .scene 字段待用户后续说明）

**反向依赖机制图**：
```
                  ┌─── pipeline A 池 ───┐
                  │                     │
材质声明可见      │  RenderObject 1     │
管线 A、B   ───→  │  RenderObject 3     │
                  │                     │
                  └─────────────────────┘
                  ┌─── pipeline B 池 ───┐
                  │  RenderObject 1  ←──┘ 同一对象多池
                  │  RenderObject 2     │
                  └─────────────────────┘

渲染时：管线图遍历 → pipeline A 步骤 → 取 A 池 → 逐对象 draw → A 的 attachment
```

---

## 资源 #9：Shader（.shader.wgsl，新增）

- **资源类型**：着色器源代码（WGSL，单源方案——见 `project_shader_language_decision` 记忆）
- **格式**：WGSL 文本文件（VS/FS/CS 功能子集；原生 Vulkan + Web WebGPU 共享 WGSL + Naga 转 SPIR-V）
- **路径示例**：`assets/<namespace>/shaders/<name>.shader.wgsl`（待定）
- **字段结构**：纯 WGSL 源码文本（无元数据包裹，shader 是叶子资源，被管线直接引用）
- **用途**：管线执行的着色器程序（顶点变换 / 片元着色 / 计算 Pass）
- **访问方式**：（待用户后续说明，脚本一般不直接改 shader，但 mod 场景可能需要）
- **引用关系**：
  - **被管线（.pipeline）引用**——管线在自己的字段里声明使用哪个 shader（VS/FS/CS slot）
  - 一个管线可引用多个 shader（VS+FS 至少两个，compute pipeline 一个）
  - 同一 shader 可被多个管线复用
- **被引用关系**：仅被 .pipeline 引用
- **生命周期**：
  - 编辑期：Monaco + tsserver + WGSL Monarch 语法高亮（见 `docs/design/monaco-tsserver.md` 阶段 5）
  - 运行期：Runner 加载时编译 WGSL → Web 后端用 WebGPU 原生 WGSL；Native 后端用 Naga 转 SPIR-V
- **编辑器支持**：
  - Monaco 提供 Monarch 语法定义做基础高亮（无 LSP）
  - 后续可接 `wgsl-analyzer`（社区项目）走同一 LanguageFeatureRegistry 提供 LSP 能力

**Shader 与 Pipeline 的关系**：
```
.pipeline 文件
  ├─ shader VS: → .shader.wgsl 引用
  ├─ shader FS: → .shader.wgsl 引用
  ├─ bindings: [attachment / uniform / texture slots]
  └─ render states (blend / depth / cull)
```

---

## 阶段一：静态场景渲染资源集（小结）

至此 demo 场景"静态渲染"所需的资源条目已齐：

| # | 资源 | 类型 | 落盘形态 | 角色 |
|---|---|---|---|---|
| 1 | 国际化 .lang | 已实现 | properties 文本 | 文案国际化 |
| 2 | KV 数据库 .kv.json | 新增 | JSON（元数据+data） | 游戏数据存储（运行时纯内存，mod 友好） |
| 3 | 纹理 .texture | 新增 | 图片 | 渲染纹理（前期 Aseprite/外部，后期内置像素画工具） |
| 4 | 模型 .model | 新增 | 待定 | 网格数据 |
| 5 | 材质 .material | 新增 | JSON | 着色参数 + 引用纹理 + 声明可见管线 |
| 6 | 管线 .pipeline | 新增 | JSON | 单次 pass 描述，引用 shader |
| 7 | 管线图 .graph | 新增 | JSON（有向图） | 多 pass 组合，节点=attachment，边=pipeline id，根=swapchain |
| 8 | 渲染对象 | 运行时内存对象 | 不落盘 | 模型+材质+位置矩阵，反向依赖入池 |
| 9 | Shader .shader.wgsl | 新增 | WGSL 文本 | 着色器源码，被管线引用 |

**渲染运行时链路**（依据前述条目整理）：
```
1. 引擎读 .scene → 构造 RenderObject（model + material + transform）
2. 引擎读当前激活管线表 → 创建 N 个对象池
3. RenderObject 按材质的 visiblePipelines 声明 → 入对应池
4. 引擎读 .pipeline-graph → 拓扑排序管线图
5. 遍历管线图：到某 pipeline 节点 → 取该管线池 → 逐 RenderObject draw
6. draw 调用 → 加载 .pipeline 引用的 .shader.wgsl → 编译（Web 直 WGSL / Native Naga 转 SPIR-V）
7. shader 绑定 .material 引用的 .texture → 画到 attachment（图的节点）
8. 收束到 swapchain 节点 → 上屏
```

**暂不覆盖（后续阶段）**：
- 动画 / 骨骼
- 物理（最简版除外）
- 脚本运行时（独立条目待补）
- 场景实体 / 组件结构（.scene 字段待补）
- 输入事件系统
- 音频

待静态场景渲染资源集就绪后再研究这些高级特性。

---

## 实施策略（2026-10-27 校准）

**关键决策：先硬编码 demo 跑通 PBR 渲染，再反向沉淀资源字段**——不先定义完整资源协议再实现，而是用一份测试资源硬编码出可跑的渲染，从工作代码中提炼各资源的数据结构。

**Why（避免纸上推演）**：
- 资源协议字段若凭空设计，大概率漏字段或字段类型错——只有真正写过加载/渲染代码，才知道每个字段实际怎么消费
- 反向依赖 / 管线图 / 材质可见性这些机制需要真实跑通才能验证可行性
- 协议从工作代码中诞生，落地后零返工

**实施路径**：
1. **第一步（不做 .scene，不做资源加载）**：在引擎业务层硬编码一个 demo——直接读 backpack 资源 → 构造 RenderObject → 跑 PBR 管线 → 渲染到 canvas
2. **第二步（沉淀字段）**：从硬编码 demo 反向提炼出 .model / .material / .pipeline / .pipeline-graph / .texture 各资源的实际字段结构
3. **第三步（资源化）**：把硬编码值搬到资源文件，引擎改读资源——验证字段够用
4. **第四步（编辑器化）**：在 IDE 内做资源编辑器，能可视化改字段

**测试资源**：`D:\projects\LearnOpenGL\resources\objects\backpack\`

| 文件 | 用途 |
|---|---|
| `backpack.obj` | 模型网格（OBJ 格式） |
| `backpack.mtl` | 材质模板（MTL 格式，引用贴图） |
| `diffuse.jpg` | 漫反射贴图（albedo） |
| `normal.png` | 法线贴图 |
| `specular.jpg` | 高光贴图 |
| `roughness.jpg` | 粗糙度贴图 |
| `ao.jpg` | 环境遮蔽贴图 |
| `source_attribution.txt` | 资源归属说明 |

**Demo 验收目标**：
- 在 Runner 窗口（独立 Electron 进程，见 `docs/design/monaco-tsserver.md` 第 10 节）渲染出 backpack 模型
- PBR 着色正确（5 张贴图按 slot 绑定：diffuse→albedo、normal→normal、specular+roughness+ao→PBR 参数）
- 摄像机可旋转 / 缩放（最简轨道相机）
- 静态一帧渲染（不做主循环 / 不跑脚本 / 不跑物理——先验证渲染链路）

**Demo 阶段产物**：
- 引擎业务层最小实现：模型加载（OBJ 解析）+ 纹理加载（图片→WebGPU texture）+ 材质构造（PBR 参数 + 5 纹理 slot）+ 管线构造（PBR shader + bindings）+ 管线图（单管线 → swapchain）+ RenderObject + 渲染循环
- WGSL PBR shader（VS+FS）
- 资源字段草案（从硬编码值提炼）

**注意**：
- OBJ 解析可借用现有库（如 `webgl-obj-loader` / `obj-file-parser`），不自己写
- WebGPU 优先（Chrome/Electron 已支持），Canvas2D 不适合 PBR
- 本阶段不做错误处理 / 边界情况，只跑通 happy path

---

## Three.js 定位：仅 IDE 静态预览工具（2026-10-27 决策）

**决策**：Three.js 不进引擎业务层，**仅作为 IDE 进程内的静态预览工具**。

**职责切分**：

| 角色 | 用 Three.js？ | 跑在哪 |
|---|---|---|
| 引擎业务层（管线图 / 反向依赖 / WGSL / 多后端） | ❌ 不用 | Runner 窗口（独立 Electron 进程） |
| Runner 内真实游戏渲染 | ❌ 不用 | Runner 窗口 |
| IDE 内静态预览面板（`renderSceneOnce`，看场景结构不跑脚本） | ✅ 用 | IDE 渲染进程 |

**Why 这么切**：
- 引擎业务层是产品核心，必须按自有架构（管线图 + 反向依赖 + WGSL 单源 + 多后端）实现，引入 Three.js 会把业务层外包出去、堵死 Vulkan 后端路径
- IDE 静态预览只是"看资源长啥样"的辅助工具，不是引擎运行时——用 Three.js 一整套（Loader/Scene/Material/Renderer）能零成本快速实现，无需自己写解析/渲染
- 静态预览与引擎业务层解耦：预览的视觉表现不要求与 Runner 真实渲染像素级一致（预览只确认资源结构，不验证管线）

**IDE 静态预览的能力边界**：
- ✅ 加载 .obj / .gltf / .glb 模型 → 显示网格
- ✅ 加载纹理 → 显示贴图
- ✅ 轨道相机旋转 / 缩放
- ✅ 简单光照（环境光 + 方向光，预览用）
- ❌ 不跑自定义 WGSL shader（用 Three.js 内置材质即可）
- ❌ 不跑管线图（Three.js 自己有渲染流程，IDE 预览不模拟管线图）
- ❌ 不跑脚本 / 物理 / 主循环（仅静态一帧，可手动触发重渲染）
- ❌ 不要求与 Runner 视觉一致

**实施位置**：
- Three.js 装在 `app` workspace（IDE 内依赖）
- 预览组件作为 `system.preview` 资源类型的编辑器（或一种新 tab 类型），注册到 `core.editors.register`
- 资源管理器选中 .obj / .gltf / .glb → 打开预览标签 → Three.js 渲染

**与 Runner 的视觉差异处理**：
- IDE 预览：Three.js 内置 PBR 材质 + 默认光照 → "近似"显示
- Runner：自有引擎业务层 → 自有管线图 + WGSL → "精确"显示
- 用户若要看"真实渲染效果"，按 F5 启动 Runner；若只看资源结构，IDE 预览够用
- 这是 Unity / Godot 也有的区分（Editor 视图 vs Game 视图）

**与 demo 实施的关系**：
- demo（硬编码 backpack 跑 PBR）**仍走 Runner + 自有引擎业务层**，不用 Three.js
- IDE 预览是另一条独立链路，可并行实施（用 Three.js 跑 backpack 看效果是几小时的事）

---
