# LiteWeave 项目管理设计（受管理工作区 + 导入/导出）

> 状态：已实施（2026-10-21，全流程验证通过）
> 决策：后缀 `.liteweave`｜启动器界面｜彻底移除目录能力｜目录命名“项目名+短ID”（已与用户对齐）
>
> 扩展：项目资源协议（project.json v2：资源清单/命名空间/资源 id）见 `resource-protocol.md`。
>
> 实施落地：
> - 主进程 `desktop/src/projectManager.js`：list/create/open/close/import/export/remove（homeDir 可注入）
> - `desktop/src/main.js`：家目录初始化 + 旧 settings 迁移到 `~/.liteweave` + 项目管理 IPC（去掉任意目录 dialog）
> - 依赖：`adm-zip`（desktop）
> - 前端 `app/src/core/project/projectModule.ts`：事件/命令/API 全面扩展（open 带 id 直接打开，不带 id 回启动器）
> - `app/src/components/launcher/ProjectLauncher.tsx`：启动器界面（列表/新建/导入/导出/删除/空态）
> - `app/src/App.tsx`：按 project 状态切换 启动器/编辑器；ExplorerPanel 适配新事件载荷
> - 菜单：文件 → 新建/打开/关闭/导入/导出项目
> - 验证：17 项单测（含导入撞名新 id）+ 8 项往返（zip 逐字节一致）+ Electron 端到端（启动器→打开→编辑器→关闭→回启动器）✅
> - 调试工具：`desktop/scripts/cdp-probe.mjs`（CDP 主世界探针，`__dom__`/`__console__`/任意 IPC channel）

## 1. 背景与动机

当前“打开项目”是**对真实磁盘目录直接操作**（`desktop/src/main.js` 弹系统目录选择框 → `readDirTree` 递归读目录树）。问题：

- 项目 = 任意磁盘路径，用户可移动/改名/删除，路径易坏
- 编辑器必须依赖系统 dialog，Web 模式拿不到绝对路径
- 引擎侧无稳定交付物，协议边界不清晰

**新方向**：把“项目”从裸磁盘目录抽象为**受管理的工作区容器**（类似 Unity Hub / Godot 项目管理器）。

## 2. 目录布局

```
~/.liteweave/                    # “家”目录，启动时确保存在
├── settings.json                # 全局配置（从 userData 迁移到这里）
└── projects/
    └── <name>-<shortId>/        # 受管理的项目目录
        ├── project.json         # 元数据：name/createdAt/formatVersion/engineVersion…
        └── assets/ scenes/ …    # 资源（引擎消费的是导出的资源包，不直接读此目录）
```

- **家目录**：`os.homedir()/.liteweave`（跨平台），主进程启动时 `mkdir -p`
- **项目目录命名**：`<项目名>-<短ID>`（如 `MyGame-a3f9`）。`project.json` 存显示名。
  - 重名/重命名不改磁盘路径，导入导出引用稳定
  - 短 ID：4 位随机（base36），撞名追加
- **settings.json 迁移**：从 Electron `userData` 迁到 `~/.liteweave/settings.json`（用户方向：统一“家”目录）

## 3. 项目元数据（project.json）

```json
{
  "name": "MyGame",
  "id": "a3f9",
  "createdAt": "2026-10-21T12:00:00Z",
  "updatedAt": "2026-10-21T12:00:00Z",
  "formatVersion": 1,
  "engineVersion": "0.1.0"
}
```

`formatVersion` 用于导入时的版本校验/迁移预留。

## 4. 主进程能力（IPC invoke）

| channel | 入参 | 返回 | 说明 |
|---|---|---|---|
| `project:list` | — | `{ projects: ProjectMeta[] }` | 扫描 `~/.liteweave/projects/*/project.json` |
| `project:create` | `{ name }` | `{ project: ProjectMeta }` | 校验名称 → 建目录 + 写 project.json |
| `project:open` | `{ id }` | `{ project, tree }` | 按 id 打开，读目录树（复用 readDirTree，根固定为项目目录） |
| `project:close` | — | `{ ok: true }` | 通知前端清状态（前端主导，主进程记录最近打开） |
| `project:import` | — | `{ project }` | 弹系统文件框选 `.liteweave` → 解压到 projects/ → 加列表 |
| `project:export` | `{ id }` | `{ ok, path? }` | 打包项目目录为 `.liteweave` → 弹保存框选落点 |
| `project:remove` | `{ id }` | `{ ok: true }` | 删除项目目录（启动器内确认） |
| `project:readDir` | `{ id }` | `{ tree }` | 保留：按 id 读目录（AI/命令驱动通道），根固定为项目目录 |

- **彻底移除**“打开任意磁盘目录”能力：删掉 `project:open`（dialog 选目录）与 `project:readDir`（按任意路径）
- `readDirTree` 保留，根固定为项目目录（不再暴露任意路径）

## 5. 导入/导出（zip + 自定义后缀）

- **格式**：zip 压缩包，重命名为 `.liteweave` 后缀
- **导入**（`project:import`）：
  - 弹系统文件框选 `.liteweave`
  - 校验 magic bytes（`PK\x03\x04`）确认为 zip
  - 解压到 `~/.liteweave/projects/<name>-<id>/`（重名冲突 → 自动改名，读 project.json 还原元数据）
- **导出**（`project:export`）：
  - 打包 `projects/<name>-<id>/` 为 zip
  - 弹系统保存框，默认名 `<name>.liteweave`
- **依赖**：`adm-zip`（纯 JS，无原生依赖，主进程侧使用）

## 6. 前端模块改造（projectModule）

### 状态

```ts
projectList: ProjectMeta[]      // 启动器列表
currentProject: ProjectMeta     // 当前打开项目
projectPath: string | undefined // 当前项目磁盘路径（读资源树用）
tree: ProjectNode[] | undefined // 当前资源树
```

### 事件

| 事件 | 载荷 | 说明 |
|---|---|---|
| `project:opened` | `{ project, tree }` | 打开成功 |
| `project:open-failed` | `{ error }` | 打开失败 |
| `project:closed` | — | 关闭当前项目（启动器显示） |
| `project:list-changed` | `{ projects }` | 项目列表变更（增删/导入导出后刷新） |

### 命令（走统一指令通道）

| 命令 | 参数 | 说明 |
|---|---|---|
| `project:create` | `{ name }` | 新建项目 → 自动打开 |
| `project:open` | `{ id }` | 打开项目（id 驱动，AI/人工统一入口） |
| `project:close` | — | 关闭当前项目 |
| `project:import` | — | 导入 `.liteweave`（弹文件框，主进程侧） |
| `project:export` | `{ id }` | 导出项目 |
| `project:remove` | `{ id }` | 删除项目 |

### API（挂 ctx.project，供组件/其他模块取用）

```ts
interface ProjectApi {
  list(): Promise<ProjectMeta[]>          // 拉取项目列表
  create(name: string): Promise<Result>   // 新建并打开
  open(id: string): Promise<Result>       // 打开
  close(): Promise<void>                  // 关闭
  import(): Promise<Result>               // 导入 .liteweave
  export(id: string): Promise<Result>     // 导出
  remove(id: string): Promise<Result>     // 删除
  getCurrentProject(): ProjectMeta | undefined
  getTree(): ProjectNode[] | undefined
  subscribe(listener): () => void
}
```

## 7. 启动器界面（ProjectLauncher）

- **形态**：类 Unity Hub 独立界面。启动时若未打开项目，显示启动器；打开项目后进入编辑器
- **组件**：`app/src/components/launcher/ProjectLauncher.tsx`
- **内容**：
  - 项目列表（名称 / 更新时间 / 打开按钮）
  - 新建项目（名称输入 → `project:create`）
  - 导入 `.liteweave` 按钮
  - 每个项目：导出 / 删除
- **挂载点**：`App.tsx` 根据 `project` 状态切换 `ProjectLauncher` 与 `AppShell`
- **空态**：无项目时显示引导（新建 / 导入）

## 8. 菜单改造（MenuBar）

- `文件 → 打开项目`：改为打开启动器（`project:open` 语义改为“列出项目选择”）
- 新增 `文件 → 新建项目`、`文件 → 关闭项目`、`文件 → 导入项目`、`文件 → 导出项目`
- 菜单项绑定到对应命令

## 9. 设置迁移

- 主进程启动时确保 `~/.liteweave/` 存在（`fs.mkdir({ recursive: true })`）
- settings.json 落点从 `app.getPath('userData')` 改为 `~/.liteweave`
- **迁移策略**：首次启动时若旧路径（userData/settings.json）存在而新路径不存在，复制过去（可选，MVP 可不做）

## 10. 实施步骤（建议顺序）

1. **主进程**：家目录初始化 + settings 迁移
2. **主进程**：ProjectManager 服务（list/create/open/close/import/export/remove）
3. **依赖**：引入 `adm-zip`（desktop 侧）
4. **前端**：projectModule 改造（事件/命令/API）
5. **前端**：ProjectLauncher 启动器界面 + App.tsx 切换
6. **菜单**：文件菜单接入新建/关闭/导入/导出
7. **验证**：启动器全流程 + 导入导出往返 + 重名处理 + Web 降级提示

## 11. 待确认 / 遗留

- `project:close` 是否持久化“最近打开项目”（下次启动自动进入）？MVP 可不做
- 删除项目是否进回收站？MVP 直接删（启动器内二次确认）
- `formatVersion` 迁移逻辑：MVP 只校验，不迁移
