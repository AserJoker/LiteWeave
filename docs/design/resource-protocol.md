# LiteWeave 项目资源协议（project.json v2）

> 状态：项目创建链路已实施（2026-10-22）；资源清单维护/编辑器对接/迁移待后续
> 决策：资源 type=引擎资源类别｜命名空间=顶层目录｜清单权威+编辑器维护｜type=2d/3d 全局配置+资源过滤｜settings 分域分组
>
> 实施落地（创建链路）：
> - 主进程 `projectManager.js`：create 支持 type/defaultNamespace，写 v2 骨架（settings 分域/entry/resources）+ 建 `assets/<ns>/scenes/`；ensureV2Fields v1→v2 迁移（open/import 自动补字段写回）；FORMAT_VERSION=2
> - `main.js`：IPC project:create 透传 type/defaultNamespace；MCP system.project:create schema 加 type/defaultNamespace
> - 前端 `projectModule.ts`：ProjectMeta 加 v2 字段 + ProjectType；create 签名改 CreateProjectArgs；创建后自动 open（广播 PROJECT_OPENED → 进编辑器）
> - `ProjectLauncher.tsx`：新建对话框加 2d/3d 选择 + 默认命名空间（随项目名联动，可手改）；底部按钮右下边距/横向内边距样式
> - 幂等保护：create 用**磁盘文件锁**（`~/.liteweave/.create.lock`，fs.mkdir EEXIST 原子性 + stale 超时清理）串行化跨进程/多实例的创建；锁内 findDirByName 同名检查，同名返回已有（reused:true）。验证：单进程 8 并发同名 → 1 项目；两独立 Node 进程并发 → 1 项目；MCP 并行两次同名 create → 1 项目 ✅
> - 验证：逻辑层单测（注入 homeDir）+ 前端/MCP 端到端（2d/3d、命名空间、自动打开）✅
>
> 前置：项目管理 v1（受管理工作区 + 导入/导出）见 `project-management.md`。本协议在 v1 的 project.json 元数据之上扩展为 v2：加入资源清单与命名空间，使 **引擎仅凭 project.json 即可定位/加载任意资源**。

## 1. 目标

当前 `project.json` 只有管理元数据（name/id/formatVersion…），资源树是打开项目时 `readDirTree` 动态扫描磁盘得到的——**引擎无法脱离编辑器定位资源**，也没有稳定的资源寻址规则。

本协议定义 **资源的唯一寻址方式** 与 **项目整体参数** 的承载文件，目标：

- 引擎/运行时凭 `project.json` 加载任意资源，不依赖编辑器
- 资源有稳定 id（跨磁盘布局/跨语言稳定），供引用、热更、打包
- 项目整体参数集中、分域、可演进

## 2. 核心概念

### 2.1 命名空间（Namespace）

- 命名空间是**引擎/资源命名上的**归属（区别于编辑器自身的模块命名空间）
- 项目至少 1 个命名空间，可多个
- `defaultNamespace` 为默认归属（新建资源未指定时落这里），**必须 ∈ namespaces**
- 命名规则：`^[a-zA-Z][a-zA-Z0-9_]*$`（小写建议，如 `demo`、`ui`、`fx`）
- 命名空间 = 顶层目录（见 §4 磁盘布局）

### 2.2 资源 id

**资源 id = `<namespace>:<path>`**，path 用 `/` 分隔（协议层统一正斜杠，不暴露 `\`）：

```
demo:i18n/zh_CN.lang
demo:scenes/main.scene
fx:particles/explosion.fx
```

- `namespace` = 资源所属命名空间（= 顶层目录名）
- `path` = 相对该命名空间目录的路径（不含扩展名也可含，含扩展名更精确）
- **id 是资源在引擎/协议层的唯一标识**，引用、热更、打包、跨项目协作都用它
- 资源 id 不依赖绝对磁盘路径 → 目录移动/项目容器迁移不影响引擎寻址

### 2.3 资源类型（type）

- `type` = **引擎资源类别**（scene / sprite / animation / i18n / ui / prefab / model / mesh / material / tilemap / sound…）
- 引擎按类别分派加载器；**文件格式由 path 后缀推断**（`.lang` → i18n、`.scene` → scene）
- type 是类别语义，format 是技术格式——type 决定引擎怎么加载，后缀决定用什么解析

### 2.4 2D / 3D 项目

- `type: "2d" | "3d"`，**创建项目时指定**，只作全局配置
- 影响范围：后续**可创建资源的类型集合过滤**（3D 有 model/mesh/material，2D 有 sprite/tilemap）+ 编辑器/资源细分
- 暂不引模板、不引引擎启动配置（MVP 只记录 + 过滤）

## 3. project.json v2 Schema

```jsonc
{
  // ---- 身份 / 版本 ----
  "formatVersion": 2,            // project.json 协议版本（迁移预留）
  "engineVersion": "0.1.0",      // 目标引擎版本
  "name": "DemoGame",            // 项目显示名
  "id": "rd3f",                  // 短 ID（编辑器管理用，不进资源协议）
  "createdAt": "2026-10-22T00:00:00Z",
  "updatedAt": "2026-10-22T00:00:00Z",

  // ---- 项目形态 ----
  "type": "2d",                  // '2d' | '3d'，创建时指定
  "defaultNamespace": "demo",    // 默认命名空间（新资源默认归属）
  "namespaces": ["demo"],        // 全部命名空间，≥1，defaultNamespace 必在内

  // ---- 整体参数（分域分组）----
  "settings": {
    "rendering": { "width": 960, "height": 540, "backgroundColor": "#1a1a2e" },
    "input":     { "map": { "jump": ["Space"] } },
    "physics":   { "gravity": 980 },
    "build":     { "entryScene": "demo:scenes/main.scene" }
  },

  // ---- 启动入口 ----
  "entry": "demo:scenes/main.scene",   // 引擎启动时加载的根场景（资源 id）

  // ---- 资源清单（平铺、权威、编辑器维护）----
  "resources": [
    { "id": "demo:scenes/main.scene", "type": "scene",  "path": "scenes/main.scene" },
    { "id": "demo:i18n/zh_CN.lang",   "type": "i18n",   "path": "i18n/zh_CN.lang" },
    { "id": "demo:sprites/hero.png",  "type": "sprite", "path": "sprites/hero.png" }
  ]
}
```

### 3.1 字段表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `formatVersion` | number | ✅ | 协议版本（当前 2），导入/迁移校验 |
| `engineVersion` | string | ✅ | 目标引擎版本 |
| `name` | string | ✅ | 项目显示名 |
| `id` | string | ✅ | 短 ID（编辑器管理；不参与资源寻址） |
| `createdAt` / `updatedAt` | string(ISO) | ✅ | 时间戳 |
| `type` | `'2d' \| '3d'` | ✅ | 项目形态（全局配置） |
| `defaultNamespace` | string | ✅ | 默认命名空间 |
| `namespaces` | string[] | ✅ | ≥1，defaultNamespace ∈ namespaces |
| `settings` | object | ✅ | 分域整体参数（§3.2） |
| `entry` | string(资源id) | ✅ | 引擎启动入口场景 |
| `resources` | array | ✅ | 资源清单（§3.3） |

### 3.2 settings 分域

- `rendering`：分辨率 / 背景色 / 默认相机…
- `input`：输入映射
- `physics`：重力 / 物理单位
- `build`：入口场景 / 输出平台
- 分域独立演进：新增域不影响已有结构；字段按域 schema 校验（schema 由各域模块注册，遵循 schema 驱动 UI 引擎约定）

### 3.3 resources 清单条目

```jsonc
{
  "id": "demo:sprites/hero.png",   // 资源唯一 id（<ns>:<path>）
  "type": "sprite",                // 引擎资源类别
  "path": "sprites/hero.png"       // 相对命名空间目录的路径
}
```

**权威性**：清单是唯一权威，编辑器维护（增删资源时自动同步）；打开项目时校验磁盘与清单一致性并提示漂移。

## 4. 磁盘布局

```
~/.liteweave/projects/<name>-<shortId>/
├── project.json
└── assets/
    ├── demo/               # 命名空间 = 顶层目录
    │   ├── scenes/main.scene
    │   ├── i18n/zh_CN.lang
    │   └── sprites/hero.png
    └── fx/                 # 第二个命名空间
        └── particles/explosion.fx
```

**映射规则**：资源 id `demo:scenes/main.scene` → 磁盘 `<projectDir>/assets/demo/scenes/main.scene`

- 命名空间 → `assets/<namespace>/`
- id 的 path 部分 → 相对该命名空间目录
- 非资源文件（编辑器缓存、配置）放 `assets/` 之外（如 `config/`、`.lw/`），不进入 resources 清单

## 5. id 解析算法

```
parse(id): { namespace, path }        // 按第一个 ':' 切分；无 ':' → 默认命名空间 + 全串为 path
resolve(projectDir, id) → absPath     // <projectDir>/assets/<namespace>/<path>
validate(project):                     // namespaces 非空 & 唯一；defaultNamespace ∈ namespaces；id 唯一
```

## 6. 编辑器维护职责

| 操作 | 行为 |
|---|---|
| 新建资源 | 写入清单（id 自动生成：defaultNamespace + 相对路径），创建磁盘文件 |
| 删除资源 | 删除磁盘文件 + 从清单移除 |
| 重命名/移动 | 更新磁盘路径 + 清单 id/path，级联更新引用方 |
| 打开项目 | 校验磁盘 vs 清单一致性：缺失/多余文件 → 漂移报告（不自动改，提示用户） |
| 新建项目 | 创建 `assets/<defaultNamespace>/` 骨架 + project.json v2 |

## 7. 迁移（v1 → v2）

- `formatVersion: 1` → `2`：读 v1 project.json，缺字段补默认
  - `type`：默认 `2d`
  - `defaultNamespace` / `namespaces`：默认 = 项目名小写化（如 `DemoGame` → `demo`），并提示可改
  - `resources`：扫描 `assets/` 重建清单（类型按后缀推断），作为一次性迁移
- 迁移后写回 v2；导入 `.liteweave` 时同样处理（读 v1 包 → 迁移 → v2）

## 8. 落地改动范围

| 层 | 改动 |
|---|---|
| 协议 | 新建 `docs/design/resource-protocol.md`（本文档）；v1 `project-management.md` 标注扩展点 |
| 主进程 `projectManager.js` | `create()` 写 v2 骨架（type/defaultNamespace/namespaces/settings/entry/resources）+ 建 `assets/<ns>/`；`open()` 返回 `project` 含 v2 字段 + 清单；新增清单维护能力（add/remove/rename）与一致性校验 |
| 前端 `projectModule.ts` | `ProjectMeta` 扩展 v2 字段；新建项目参数加 `type`（2d/3d 选择）；资源树对接清单（而非纯磁盘扫描） |
| 前端 `ProjectLauncher.tsx` | 新建项目表单加 2d/3d 选择；默认命名空间展示（可改） |
| 设置/编辑器 | 资源类型集合按 `type` 过滤（3D 有 model/mesh/material） |
| 验证 | 单测（id 解析/校验/一致性）+ 端到端（新建 2d/3d → 增删资源 → 清单同步 → 导出/导入往返） |

## 9. 待确认 / 后续

- 资源引用（scene 内引用其他资源 id）的格式——本协议只定清单，引用语法待资源格式协议
- 命名空间管理 UI（新增/删除命名空间）——MVP 可只在 project.json 手动维护
- 漂移提示的交互形态（对话框 / 面板角标）
- `entry` 是否必需——MVP 默认取 `defaultNamespace:scenes/main.scene`，缺失则引擎显示空场景
