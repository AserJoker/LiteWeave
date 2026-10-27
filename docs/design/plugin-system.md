# LiteWeave 插件系统设计（链路归一化流程）

> 状态：设计定稿（2026-10-22）
> 决策：**系统本身 = 一个内置插件**，走完整插件流程；插件=端到端业务域；命令元数据**前端注册+回传主进程**；引入**编辑器注册器**消除 switch 硬编码
>
> 前置：事件驱动框架（`app/src/core/`）、模块注册（Module init/dispose）、命名空间隔离（system 前缀）、Schema 驱动 UI 引擎、资源类型注册表、project.json 资源协议 v2。

## 1. 背景与动机

当前系统的注册是**零散**的：

| 资源 | 现状 | 问题 |
|---|---|---|
| 数据域模块（settings/layout） | `appCore.ts` 逐个 `createStoreModule` | 硬编码装配，非统一流程 |
| schema / 渲染器 | `appCore.ts` 直接 `core.schemas.register` | 平铺，无插件载体 |
| **资源类型** | `resourceTypes.ts` 静态数组 `BUILTIN_RESOURCE_TYPES` | **无注册器**，插件无法扩展 |
| **编辑器分派** | `WorkspaceTabs.tsx` `switch(tab.type)` | **硬编码 switch**，新增编辑器要改组件 |
| **侧边栏面板** | `Left/RightSidebar.tsx` 静态 tab 列表 + 硬编码渲染 | **无注册器** |
| **菜单** | `MenuBar.tsx` 静态 `MENUS` 数组 + `switch(i18nKey)` | **无注册器** |
| **MCP 命令清单** | `desktop/src/main.js` 静态数组 `MCP_COMMANDS` | 与前端命令注册**分离**，两处维护易漂移 |
| IPC channel | `main.js` 逐条 `ipcMain.handle` | 主进程硬编码 |

早期设计已埋下插件化意图（namespace 隔离、schema/schemaRenderers/resourceTypes 均注明“插件可注册”），但**缺一个统一载体**：插件要注册自己的资源，可这 5 类（资源类型/编辑器/面板/菜单/MCP 命令）**连注册器都没有**——系统自己都不是经统一流程挂载的。

**归一方向**：把**系统本身视作一个内置插件**，走完整的插件流程；第三方插件与系统插件**完全同一条链路**。一个插件 = 一个**端到端业务域**（不是按注册器拆碎，而是聚合承载某业务的所有资源注册）。

## 2. 目标

- **统一插件协议**：插件 = 端到端业务域，一个插件负责自己业务的所有资源注册（事件/命令/schema/渲染器/资源类型/编辑器/面板/菜单/MCP 命令）
- **补齐缺失注册器**：资源类型、编辑器、面板、菜单、MCP 命令 5 类注册器，让插件只向注册器声明、不写硬编码
- **系统内置插件归一**：现有所有系统资源收敛为一个 `system` 插件，走与第三方插件相同的 register→init→start 流程
- **MCP 命令单一来源**：命令元数据前端注册（命令 handler 本就在前端），聚合后经 IPC 回传主进程 MCP server
- **消除硬编码分派**：WorkspaceTabs / Sidebar / MenuBar 改为按注册表渲染

## 3. 插件协议

### 3.1 Plugin 接口（复用并升级 Module）

现有 `Module`（`id + init(ctx) + dispose?`）已是插件雏形，升级为 `Plugin`（`Module` 保留兼容别名），并把生命周期从单级 `init` 扩展为**三级钩子**：

```ts
/** 插件：一个端到端业务域，通过三级生命周期向各注册器声明资源并与其他插件联动 */
export interface Plugin {
  /** 全局唯一 id（命名空间风格）：系统内置用 system，第三方用 <vendor>.<name> */
  id: string
  /** 插件版本（可选） */
  version?: string
  /** 插件显示名 i18n key（可选；用于插件列表 UI） */
  nameKey?: string
  /**
   * 一级钩子 preInit：配置加载生效 / 插件自身初始化。
   * 此时其它插件的资源尚未注册，只能加载自己的配置、准备运行环境；
   * 不能引用其它插件注册的资源（schema/编辑器/面板…）。
   */
  preInit?(ctx: PluginContext): void | Promise<void>
  /**
   * 二级钩子 init：注册资源 + 初始化订阅。
   * 向各注册器注册自己业务的所有资源（事件/命令/schema/渲染器/资源类型/编辑器/面板/菜单/MCP 命令），
   * 并订阅自己关心的事件。只能读自己的 preInit 产物，不能依赖其它插件的注册结果。
   */
  init(ctx: PluginContext): void | Promise<void>
  /**
   * 三级钩子 postInit：patch 资源 / 与其他插件联动。
   * 所有插件 init 完成后执行：可 patch 其它插件已注册的资源
   * （如 SchemaRegistry.patch 给 select 加选项、改 helper 文案）、订阅其它插件的事件、跨插件联动。
   */
  postInit?(ctx: PluginContext): void | Promise<void>
  /** 卸载协议（尽力而为，不保证真正移除已注册资源） */
  dispose?(): void | Promise<void>
}

/** 兼容别名：现有 Module 即 Plugin（单级 init 的模块可视为只用了二级钩子的插件） */
export type Module = Plugin
```

- **id 约定**：系统内置 `system`（单个插件承载全部系统资源）；第三方 `<vendor>.<name>`（如 `mycompany.terrain`）。命名空间隔离（见 `namespace.ts`）天然保证命令/事件/字段不冲突。
- **一个插件 = 一个业务域**：如 `project` 插件注册 project 相关的事件/命令/schema/资源类型/编辑器/面板/菜单；`settings` 插件注册设置相关…… 系统内置可拆也可合（见 §6 落地形态），协议上**不限制粒度**，但语义上“一个插件端到端负责一个业务”。
- **为什么是三级而非单级**：跨插件 patch/联动（postInit 的职责）依赖“其它插件已注册资源”这个前提，单级 init 无法表达“注册完再联动”的顺序；三级钩子把“配置加载 → 注册资源 → 联动”拆开，由宿主分层批量调度（见 §5）。

### 3.2 PluginContext（补齐缺失注册器）

`PluginContext` 即扩展后的 `ModuleContext`。现有 6 个注册器（events/commands/i18n/schemas/schemaRenderers/transport）**保留**，补齐 5 个：

```ts
export interface PluginContext extends ModuleContext {
  /** 资源类型注册器：文件 → 类型 → 编辑器/图标 */
  readonly resourceTypes: ResourceTypeRegistry
  /** 编辑器注册器：资源类型 id → 编辑器渲染组件（WorkspaceTabs 按注册表分派） */
  readonly editors: EditorRegistry
  /** 侧边栏面板注册器：面板 id → 标题/图标/渲染组件（Left/RightSidebar 按注册表渲染） */
  readonly panels: PanelRegistry
  /** 菜单注册器：菜单项声明（含命令绑定）（MenuBar 按注册表渲染） */
  readonly menus: MenuRegistry
  /** MCP 命令注册器：命令元数据（name/description/schema），聚合后回传主进程 */
  readonly mcpCommands: McpCommandRegistry
}
```

## 4. 缺失注册器设计

### 4.1 资源类型注册器（ResourceTypeRegistry）

现有 `resourceTypes.ts` 的 `BUILTIN_RESOURCE_TYPES` 静态数组升级为注册器：

```ts
export interface ResourceTypeRegistry {
  /** 注册一个资源类型；重复 type 报错 */
  register(type: ResourceType): void
  /** 按 type 取 */
  get(type: string): ResourceType | undefined
  /** 按文件节点匹配（第一个命中优先） */
  match(node: Pick<ProjectNode, 'name' | 'path' | 'type'>): ResourceType | undefined
  /** 全部已注册 */
  list(): ResourceType[]
  /** 移除（测试/卸载） */
  unregister(type: string): void
}
```

`ResourceType` 结构沿用：`{ type, titleKey, icon, matches(node) }`（`type` 为 `<namespace>.<name>` 命名空间 id）。

### 4.2 编辑器注册器（EditorRegistry）

**新增**。核心解决 `WorkspaceTabs.tsx` 的 `switch(tab.type)` 硬编码分派：

```ts
export interface EditorProps {
  /** 资源类型 id（tab.type） */
  type: string
  /** 编辑器标签（含 path/title/id） */
  tab: EditorTab
}

export type EditorComponent = (props: EditorProps) => ReactNode

export interface EditorRegistry {
  /** 注册：资源类型 id → 编辑器渲染组件 */
  register(type: string, component: EditorComponent): void
  /** 按资源类型 id 取渲染组件（未注册返回 undefined → 占位） */
  get(type: string): EditorComponent | undefined
  /** 全部已注册 */
  list(): string[]
}
```

- `WorkspaceTabs.renderPanel` 改为：`switch(tab.type)` → `ctx.editors.get(tab.type)?.(...) ?? 占位`。
- 插件注册资源类型 + 编辑器即完成扩展，**无需改组件**。
- 一个资源类型一个编辑器组件（当前足够）；多编辑器/单编辑器多类型后续可扩展（`EditorRegistry` 的 key 保持资源类型 id）。

### 4.3 侧边栏面板注册器（PanelRegistry）

解决 `Left/RightSidebar.tsx` 静态 tab 列表 + 硬编码渲染：

```ts
export interface PanelDefinition {
  /** 面板 id（如 explorer / inspector；与 layout 的 activePanel 对应） */
  id: string
  /** 面板标题 i18n key */
  titleKey: string
  /** Blueprint icon 名 */
  icon: string
  /** 面板渲染组件 */
  component: React.ComponentType
  /** 归属侧边栏：'left' | 'right'（默认 left） */
  side?: 'left' | 'right'
}

export interface PanelRegistry {
  register(def: PanelDefinition): void
  get(id: string): PanelDefinition | undefined
  list(side?: 'left' | 'right'): PanelDefinition[]
}
```

- `LeftSidebar` / `RightSidebar` 改为：按注册表过滤 `side` 渲染 tab 头 + 内容，**不再硬编码**。
- layout 的 `activePanel`（PanelId）与面板注册 id 对齐。

### 4.4 菜单注册器（MenuRegistry）

解决 `MenuBar.tsx` 静态 `MENUS` 数组 + `switch(i18nKey)` 硬编码：

```ts
export interface MenuItemDef {
  /** 菜单项 i18n key */
  i18nKey: string
  icon?: string
  hotkey?: string
  dividerAfter?: boolean
  /** 菜单项命令（点击 → runCommand；命令名带命名空间） */
  command?: string
  /** 命令参数（可选） */
  commandArgs?: unknown
  /** 或自定义点击处理（与 command 二选一） */
  onClick?: () => void
}

export interface MenuDef {
  /** 菜单名 i18n key */
  i18nKey: string
  items: MenuItemDef[]
}

export interface MenuRegistry {
  register(menu: MenuDef): void
  /** 全部已注册菜单（按注册顺序） */
  list(): MenuDef[]
  /** 向既有菜单追加项（插件扩展既有菜单） */
  append(menuKey: string, item: MenuItemDef): void
}
```

- 系统内置菜单（文件/编辑/视图/帮助）由 system 插件注册；`MenuItemDef.command` 取代 MenuBar 里的 `switch(i18nKey)` 手动分发。
- 插件可 `register` 新菜单或 `append` 进既有菜单。

### 4.5 MCP 命令注册器（McpCommandRegistry）

**单一来源在前端**（命令 handler 本就在前端），聚合后回传主进程：

```ts
export interface McpCommandDef {
  /** 命令名（命名空间风格，如 system.project:create） */
  name: string
  /** 描述（MCP 工具 description） */
  description: string
  /** 参数 schema 描述（主进程用 zod 构建；前端存结构，回传主进程转 zod） */
  args?: Record<string, { type: string; optional?: boolean; description: string; enum?: string[] }>
}

export interface McpCommandRegistry {
  register(def: McpCommandDef): void
  get(name: string): McpCommandDef | undefined
  list(): McpCommandDef[]
}
```

- 插件在前端 `init` 注册命令元数据；`PluginHost.start()` 或专门同步时机聚合 `list()` → `transport.invoke('mcp:commands:sync', commands)` 回传主进程。
- 主进程 `ipcMain.handle('mcp:commands:sync')` 更新 MCP server 的命令清单（替换静态 `MCP_COMMANDS` 数组）。
- 命令 handler 仍由渲染进程插件在 `init` 注册（`ctx.commands.onCommand`），与元数据天然同源同命名空间。

## 5. 插件宿主（PluginHost）

复用并升级现有 `ModuleManager`（`register/unregister/get/registered`），把生命周期从“单级 init + start”升级为**三级钩子 + start**：

```ts
export interface PluginHost {
  /**
   * 注册插件：重复 id 报错。
   * 注意：register 只登记插件（不做三阶段调度），三阶段由 start() 统一批量执行。
   */
  register(plugin: Plugin): Promise<void>
  /**
   * 启动就绪：批量执行三级生命周期 + 聚合回传。
   * 顺序（分层批量，而非每插件串行三阶段）：
   *   1) 全部插件 preInit（配置加载生效 / 插件自身初始化）
   *   2) 全部插件 init（注册资源 + 初始化订阅）
   *   3) 全部插件 postInit（patch 资源 / 与其他插件联动）
   *   4) 宿主就绪动作：聚合回传 MCP 命令清单等
   */
  start(): Promise<void>
  /** 卸载插件：调用 dispose()（尽力而为） */
  unregister(pluginId: string): Promise<void>
  /** 获取已注册插件 */
  get(pluginId: string): Plugin | undefined
  /** 已注册插件 id 列表 */
  registered(): string[]
}
```

**为什么分层批量**：postInit 的语义是“patch 其它插件已注册的资源 / 跨插件联动”，前提是**所有插件的资源都已注册完**。若每插件串行三阶段（A.preInit→A.init→A.postInit→B.preInit→…），A 的 postInit 想 patch B 的资源时 B 还没 init，前提不成立。因此宿主必须**按阶段批量推进**：先全部 preInit，再全部 init，最后全部 postInit。

**三阶段职责（与 Plugin 接口 §3.1 对应）**：

| 阶段 | 职责 | 能引用其它插件资源？ | 典型动作 |
|---|---|---|---|
| `preInit` | 配置加载生效 / 插件自身初始化 | ❌（其它插件尚未注册） | 读配置、准备运行环境 |
| `init` | 注册资源 + 初始化订阅 | ❌（只能读自己的 preInit 产物） | register 事件/命令/schema/编辑器/面板/菜单/MCP、订阅事件 |
| `postInit` | patch 资源 / 与其他插件联动 | ✅（所有插件已 init） | `schemas.patch` 给 select 加选项、订阅其它插件事件 |

**start() 的定位**：start 承载“三级生命周期调度 + 宿主就绪动作”（如回传 MCP 命令清单）。系统内置插件与第三方插件都走 `register → start`。

生命周期：

```
register(plugin1..N)          // 只登记，不执行
  → start()
    → 批量 preInit（配置加载生效 / 插件自身初始化）
    → 批量 init（注册资源 + 初始化订阅）
    → 批量 postInit（patch 资源 / 与其他插件联动）
    → 宿主就绪：聚合回传 MCP 命令清单
  → dispose()（卸载协议，尽力而为）
```

**错误处理**：某阶段某插件抛错 → 记录错误，该插件标记失败（不参与后续阶段），其余插件继续；与现有 `ModuleManager` 的“init 抛错回滚”语义一致，但失败隔离更宽松（不因单插件失败而中断整批）。

## 6. 系统内置插件落地形态

按用户决策“实际上就是一个，未来插件也是一个插件负责端到端所有业务”，系统内置**收敛为一个 system 插件**（内部可分段组织 init，但对外是一个插件）：

```ts
// app/src/core/systemPlugin.ts
export const systemPlugin: Plugin = {
  id: 'system',
  version: '0.1.0',
  async preInit(ctx) {
    // 一级：配置加载生效 / 插件自身初始化（系统内置一般无外部配置，可空实现或读 ~/.liteweave）
  },
  async init(ctx) {
    // 二级：注册资源 + 初始化订阅
    // —— 数据域：settings / layout ——
    await ctx.modules.register(createStoreModule('settings'))
    await ctx.modules.register(createStoreModule('layout'))
    // —— project 业务域 ——
    await ctx.modules.register(createProjectModule())
    // —— 事件/命令（已由各模块 init 注册）——
    // —— schema ——
    ctx.schemas.register(demoSchema)
    ctx.schemas.register(createProjectSchema)
    ctx.schemas.register(projectConfigSchema)
    ctx.schemaRenderers.register(STORE_SELECT_TYPE, storeSelectRenderer)
    // —— 资源类型 + 编辑器 ——
    ctx.resourceTypes.register(PROJECT_CONFIG_RESOURCE_TYPE)
    ctx.editors.register(PROJECT_CONFIG_RESOURCE_TYPE, ProjectConfigEditor)
    // —— 侧边栏面板 ——
    ctx.panels.register({ id: 'explorer', titleKey: 'system.explorer.title', icon: 'folder-open', component: ExplorerPanel, side: 'left' })
    ctx.panels.register({ id: 'inspector', titleKey: 'system.inspector.title', icon: 'properties', component: InspectorPanel, side: 'right' })
    // —— 菜单 ——
    ctx.menus.register(...) // 文件/编辑/视图/帮助
    // —— MCP 命令元数据 ——
    ctx.mcpCommands.register({ name: 'system.project:create', ... })
    // ...
  },
  async postInit(ctx) {
    // 三级：patch 资源 / 与其他插件联动
    // 例：给创建项目窗口的 type 选择增加 2.5D 选项（patch 自己 init 已注册的 schema）
    const typeNode = ctx.schemas.patch(CREATE_PROJECT_SCHEMA_ID, `${CREATE_PROJECT_SCHEMA_ID}.type`, {
      field: { options: [/* 2d / 3d / 2.5d */] },
    })
    // 也可订阅其它插件（未来）的事件做跨插件联动
  },
}
```

`appCore.ts` 从“逐行平铺”变为：

```ts
export async function createAppCore(): Promise<AppCore> {
  const core = createCore()  // 仍内置 events/commands/i18n/schemas/... + 新增 5 注册器
  bindTransport(core.transport)
  await core.plugins.register(systemPlugin)  // 系统作为一个插件（只登记）
  await core.plugins.start()                 // 三级生命周期（preInit→init→postInit）+ 回传 MCP 命令清单
  subscribeMcpCommands(...)                   // MCP 命令落地
  return core
}
```

> 注：`createStoreModule`/`createProjectModule` 仍是模块（内部用 init 注册事件/命令），system 插件把它们作为**子模块** register 进 `ctx.modules`——插件是业务域的聚合载体，模块是插件内的实现单元。

## 7. MCP 命令回传链路

```
渲染进程：插件 init 时 ctx.mcpCommands.register({ name: 'system.project:create', ... })
  → PluginHost.start() 聚合 ctx.mcpCommands.list()
  → transport.invoke('mcp:commands:sync', { commands })
  → 主进程 ipcMain.handle('mcp:commands:sync') 更新 MCP server 命令清单（替换静态数组）
  → MCP tools 动态暴露（system_project_create 等）
```

- **单一来源**：命令 handler 与元数据都在前端（同一命名空间），主进程只做“接收 + 暴露”。
- **一致性**：命名空间隔离保证前端命令与 MCP 工具名天然对齐（`system.project:create` ↔ `system_project_create`）。
- **主进程无需插件生命周期**（不引 PluginHost），只加一个 IPC channel 接收命令清单。

## 8. 与现有代码的关系

| 现有 | 迁移 |
|---|---|
| `resourceTypes.ts` 静态数组 | 升级为 `ResourceTypeRegistry`（保留 `matchResourceType`/`tabForResource` 兼容） |
| `WorkspaceTabs.tsx` switch(tab.type) | 改查 `editors.get(tab.type)`，未匹配占位 |
| `Left/RightSidebar.tsx` 静态 tab | 改按 `panels.list(side)` 渲染 |
| `MenuBar.tsx` 静态 MENUS + switch | 改按 `menus.list()` 渲染 + `command` 绑定 |
| `main.js` 静态 MCP_COMMANDS | 改由 `mcp:commands:sync` 回传更新 |
| `appCore.ts` 逐行注册 | 收敛为 `systemPlugin` + `plugins.register/start` |
| `module.ts` Module | 升级为 `Plugin`（三级钩子 preInit/init/postInit，兼容别名） |
| `moduleManager.ts` ModuleManager | 升级为 `PluginHost`（批量三阶段 + start） |
| `appCore.ts` 的 schema patch（2.5D 演示） | 移到 `systemPlugin.postInit`（patch 语义归属“与其他插件联动”阶段） |

## 9. 落地范围（建议顺序）

1. **核心**：`Plugin` 接口（三级钩子）+ `PluginContext` 扩展（补 5 注册器）+ `PluginHost`（批量三阶段 + start）
2. **5 个注册器实现**：resourceTypes/editors/panels/menus/mcpCommands（各自 registry + 挂 ctx）
3. **消费方改造**：WorkspaceTabs（editors）/ Left+RightSidebar（panels）/ MenuBar（menus）按注册表渲染
4. **MCP 回传**：主进程 `mcp:commands:sync` channel + 替换静态 MCP_COMMANDS
5. **system 插件**：`systemPlugin.ts` 收敛全部系统资源注册（preInit/init/postInit 三段），`appCore.ts` 改装配 host
6. **验证**：启动全流程（菜单/面板/编辑器/资源类型/MCP tools 均从注册表渲染）+ 插件视角等价性（系统插件与假想第三方插件同链路）

## 10. 后续扩展（不在本次）

- 插件加载：从磁盘目录动态加载插件（`~/.liteweave/plugins/`，package.json 描述），与内置插件同链路
- 生命周期增强：插件依赖声明（preInit/init/postInit 阶段内按依赖排序）、启用/停用 UI、插件列表面板
- 编辑器注册器增强：多编辑器/单编辑器多类型、编辑器实例状态
- MCP 命令 schema 结构化（前端 zod 描述 → 主进程直接复用，而非结构转译）
