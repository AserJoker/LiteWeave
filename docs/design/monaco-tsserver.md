# LiteWeave 代码编辑器设计（Monaco + tsserver）

> 状态：设计定稿（2026-10-27）
> 决策：**Monaco Editor 作为代码资源（.ts/.js/.json 等）统一编辑器**；**tsserver 作为独立子进程提供 TypeScript 语言服务**；二者通过 LSP-style 通道解耦，先支持本地项目内脚本智能提示，后续可扩展为多语言服务共底。
>
> 前置：插件系统（编辑器注册器）、资源管理器、.lang 资源编辑器（已落地的 Schema 驱动 UI 引擎）、MCP 命令通道。
>
> 后续：基于本基建落地"引擎业务层 + Web 后端"（独立设计文档），TypeScript 脚本运行时依赖本设计暴露的脚本编辑/校验链路。

## 1. 背景与动机

LiteWeave 定位是"资源驱动 + 脚本控制"的游戏开发 IDE。当前已落地的编辑器都是**结构化资源**（.lang / project.json），用 Schema 驱动 UI 编辑字段。但接下来的核心资源是**代码**：

| 资源类型 | 用途 | 编辑形态 |
|---|---|---|
| `.scene` | 场景图描述 | 可视化编辑器（后续） |
| `.pipeline` | 渲染管线树 | 节点连线编辑器（后续） |
| `.script` / `.ts` | 游戏脚本（事件处理、参数修改） | **代码编辑器（本设计）** |
| `.material` | 材质参数 | Schema 表单（已有引擎） |
| `.shader.wgsl` | WGSL 着色器 | 代码编辑器（本设计，复用） |

代码编辑器是引擎业务层开发的前置依赖：
- 引擎业务层本身用 TypeScript 写，开发者要在 IDE 内编辑引擎源码（dogfooding）
- 游戏脚本是 TS/JS，脚本作者需要智能提示（参数类型、引擎 API 自动补全）
- WGSL 着色器编辑虽非 TS，但复用 Monaco 的语法高亮基础（Monaco Monarch 语法定义）

**为什么不是 CodeMirror / Ace**：Monaco 是 VSCode 同源编辑器，自带 LSP 风格的语言服务集成能力、强大的 TS 内置支持、丰富的 API（命令/装饰器/视图），且社区生态成熟。LiteWeave 是 Electron 应用，Monaco 的体积/性能开销可接受。

**为什么不是直接用 VSCode Web Extension**：LiteWeave 是独立 IDE，需要深度嵌入资源管理器/标签页/MCP 命令链路，不能套个 VSCode web shell 了事。Monaco 是组件级嵌入，VSCode 是产品级封装，需求层级不同。

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│  渲染进程（Electron BrowserWindow）                          │
│                                                              │
│  ┌──────────────────────┐    ┌──────────────────────────┐  │
│  │  ExplorerPanel       │    │  WorkspaceTabs            │  │
│  │  （资源管理器）       │    │  ┌────────────────────┐  │  │
│  │  双击 .ts → 打开标签  │───▶│  │ CodeEditor         │  │  │
│  └──────────────────────┘    │  │ ┌────────────────┐ │  │  │
│                              │  │ │ Monaco         │ │  │  │
│                              │  │ │ (worker 内运行) │ │  │  │
│                              │  │ └────────────────┘ │  │  │
│                              │  └────────────────────┘  │  │
│  ┌──────────────────────┐    └──────────────────────────┘  │
│  │ TypeScriptService     │           ▲                     │
│  │  （前端单例）          │           │ IPC                  │
│  │  - openFile(path)     │           │                     │
│  │  - editFile(path,Δ)   │           │                     │
│  │  - requestHover()     │           │                     │
│  │  - requestComplete()  │           │                     │
│  └──────────────────────┘           │                     │
└──────────────────────────────────────┼─────────────────────┘
                                       │ IPC channel:
                                       │  ts:command
                                       │  ts:event
                                       ▼
┌─────────────────────────────────────────────────────────────┐
│  主进程                                                     │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ TsServerManager（spawn + 生命周期）                   │  │
│  │  - spawn tsserver.js（typescript 包内置）              │  │
│  │  - stdio 通信（LSP-style JSON 序列）                  │  │
│  │  - 项目根目录 inferredProjects / tsconfig 引用        │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ TypeScriptServiceHost（主进程侧桥接）                 │  │
│  │  - 接收渲染进程 IPC → 转 tsserver stdio               │  │
│  │  - tsserver stdio 事件 → 推渲染进程 IPC               │  │
│  │  - 维护 path ↔ tsserver 内 file id 映射               │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**核心边界**：
1. **Monaco 在渲染进程跑**（web worker 内运行编辑器内核，与 UI 解耦）
2. **tsserver 在主进程跑**（独立子进程，长生命周期，跨多个编辑器标签共享）
3. **二者通过 IPC 解耦**——Monaco 不知道 tsserver 在哪，只调 `TypeScriptService.requestXxx()`；服务在渲染进程侧是单例，转发到主进程
4. **路径是统一身份**——所有文件用项目内虚拟路径（`assets/demo/scripts/player.ts`）标识，服务端做"虚拟路径 ↔ tsserver file id"映射

## 3. 关键设计决策

### 3.1 tsserver 跑主进程而非渲染进程

**决策**：tsserver 作为主进程的子进程，不在渲染进程内跑。

**理由**：
- tsserver 是 Node 程序（用 `typescript/bin/tsserver` 启动），需要 fs 访问读取项目内文件、`tsconfig.json` 解析、跨文件类型解析
- 主进程已有 fs/IPC 基建（项目资源 CRUD 都走主进程）
- 渲染进程跑 tsserver 需要 bundler 处理 Node 内置模块，且与现有 IPC 模式不一致
- 多窗口/多标签共享一个 tsserver 实例，避免重复加载项目类型缓存

**代价**：
- 每次按键都要 IPC → 主进程 → stdio → tsserver，往返延迟高于同进程调用
- 对策：渲染进程侧用 `TypeScriptService` 做请求去重 + 防抖 + 缓存；Monaco 自带基础语法高亮（不需 tsserver 也能编辑）

### 3.2 通信协议：LSP-style 而非自己造

**决策**：tsserver 用其原生 STDIO 序列协议（`typescript/lib/protocol.d.ts`），不转 LSP。

**理由**：
- tsserver 自带的协议已经够用，转 LSP 多一层映射增加复杂度
- 协议是 line-delimited JSON，每条消息带 `seq` 序号便于请求/响应配对
- 已有 `vscode-languageserver-protocol` 等库参考实现

**消息流**：
```
渲染进程: TypeScriptService.requestHover({file, line, col})
   │
   │ IPC: ts:command {reqId, type:'request', command:'quickinfo', args:{file,line,offset}}
   ▼
主进程 TypeScriptServiceHost:
   │ 转换为 tsserver 协议: {seq:123, type:'request', command:'quickinfo', arguments:{file,line,offset}}
   │ 写入 tsserver stdin
   ▼
tsserver:
   │ 处理 → stdout 输出 {seq:124, type:'response', request_seq:123, body:{...}}
   ▼
主进程 TypeScriptServiceHost:
   │ 读 stdout → 按 request_seq 找到 pending 请求 → resolve
   │ 推 IPC: ts:event {reqId, type:'response', body:{...}}
   ▼
渲染进程: TypeScriptService 收到 → resolve pending Promise
```

**事件（非请求/响应）**：tsserver 也会主动推事件（诊断、项目加载完成等），走 `ts:event` IPC 推所有渲染进程订阅者。

### 3.3 文件模型：tsserver 看到的是真实磁盘文件

**决策**：tsserver 直接读磁盘文件，不通过 LiteWeave 资源协议抽象。

**理由**：
- tsserver 设计为操作真实文件路径（`/path/to/file.ts`），它自己读 tsconfig、解析 import、跑类型解析
- 强行抽象会丢掉 tsserver 的增量编译能力（它依赖文件 mtime + 内容 hash 做缓存）
- LiteWeave 项目根目录就是真实磁盘目录（`~/.liteweave/projects/xxx-xxx/`），tsserver 可直接以项目根为 cwd

**未保存缓冲区同步**：
- 编辑器有未保存修改时，Monaco 内容 ≠ 磁盘内容
- 通过 `command:'open'` + `command:'change'`（带 `applyTo:'file'`）告知 tsserver "内存中文件内容是 X"
- tsserver 用"未保存版本"做类型解析，但磁盘文件不变（保存后才落盘）
- 这是 tsserver 标准用法，VSCode 也是这么做的

**虚拟路径 ↔ 磁盘路径**：渲染进程只知道虚拟路径（`assets/demo/scripts/player.ts`），主进程做映射到 `C:\Users\xxx\.liteweave\projects\DemoGame-rd3f\assets\demo\scripts\player.ts`。映射在 `TypeScriptServiceHost` 内部完成，tsserver 永远见真实磁盘路径。

### 3.4 项目模型：tsserver 用 inferredProjects，不强求 tsconfig

**决策**：项目根目录传给 tsserver，让它自己推断项目结构；不强求用户写 `tsconfig.json`。

**理由**：
- 游戏脚本作者不熟悉 TS 工程化，强制 tsconfig 提高门槛
- tsserver 的 `inferredProjects` 能力够用：给一个文件，自动推断编译选项
- 引擎业务层（开发者维护）可以自己写 tsconfig，不影响

**编译选项**：通过 `command:'configure'` 给 tsserver 设默认选项（target ESNext / module ESNext / strict true / moduleResolution bundler），所有 inferred 项目继承。

**引擎类型注入**：游戏脚本会调用引擎 API（`engine.set(...)` / `engine.on(...)`），需要引擎类型声明。机制：
- 引擎包发布 `engine.d.ts` 到 `node_modules/@liteweave/engine/`
- 主进程告诉 tsserver 把这个目录加入 typeRoots
- 脚本里 `import { engine } from '@liteweave/engine'` 自动获得类型

### 3.5 Monaco 与 tsserver 集成：自建 LanguageFeatureRegistry

**决策**：不依赖 `monaco-typescript`（Monaco 自带的 TS 语言服务适配），自己写一个 `MonacoTsAdapter`。

**理由**：
- `monaco-typescript` 把 tsserver 跑在 web worker 内，整个 TS 编译器进 bundle，体积大（数 MB）且无法访问 fs
- 我们的 tsserver 在主进程跑，与 Monaco 完全解耦，需要的是"Monaco 调我们的 TypeScriptService 而非内置 worker"
- Monaco 暴露 `monaco.languages.register*Provider` 系列 API，注册 hover/completion/diagnostic/formatting/definition 等 provider 即可

**Provider 实现模板**：
```typescript
monaco.languages.registerHoverProvider('typescript', {
  provideHover: async (model, position) => {
    const file = virtualPathFromModel(model)
    const r = await tsService.requestHover({ file, line: position.lineNumber, col: position.column })
    return r ? { contents: [{ value: r.displayString }], range: rangeFromResult(r) } : null
  }
})
```

每个 provider 都是"Monaco 触发 → 转 tsserver 请求 → 转 Monaco 返回"。

### 3.6 资源类型与编辑器分派

**决策**：注册新资源类型 `system.code` + 子类型（language: typescript/javascript/json/wgsl），CodeEditor 按 language 分派 Monaco 语言模式。

**资源类型注册**（systemPlugin 内）：
```typescript
// system.code 资源类型
core.resourceTypes.register({
  id: 'system.code',
  displayName: '代码',
  extensions: ['.ts', '.js', '.json', '.wgsl'],  // 多后缀归一类型
  icon: 'code',
  defaultName: 'script.ts',
})
```

**编辑器注册**：
```typescript
core.editors.register({
  type: 'system.code',
  component: CodeEditor,
  // 按 file extension 决定 Monaco language id
  languageFor: (path) => {
    if (path.endsWith('.ts')) return 'typescript'
    if (path.endsWith('.js')) return 'javascript'
    if (path.endsWith('.json')) return 'json'
    if (path.endsWith('.wgsl')) return 'wgsl'  // 自定义 Monarch 语法
    return 'plaintext'
  },
})
```

**WGSL 支持**：Monaco 没有内置 WGSL 语法，需注册 Monarch 语法定义（一段 JSON 描述 token 规则）。这是后续增强项，初版先按 plaintext 编辑。

### 3.7 自动保存与已有模式对齐

**决策**：CodeEditor 沿用 LangEditor / ProjectConfigEditor 的"编辑即落盘"模式，不做 Ctrl+S。

**理由**：
- 已有约定（任务 #90 确认）：所有编辑器都是修改即 `core.project.writeFile()`，无未保存状态
- 菜单"保存/全部保存"已删（任务 #89）
- tsserver 的"未保存缓冲区"概念在 LiteWeave 里不存在——文件永远已保存，tsserver 直接读磁盘即可，简化 `command:'change'` 链路

**实现**：Monaco `onDidChangeModelContent` → 防抖 300ms → `core.project.writeFile(path, value)` → 写盘成功后无需告知 tsserver（它自己 fs.watch 或下次请求时重读）。

**性能保护**：大文件 (>1MB) 关闭自动保存，提示用户手动 Ctrl+S（这个快捷键再单独绑）。脚本文件不会大，先不做此分支。

### 3.8 MCP 命令注册

**决策**：暴露 TypeScript 服务能力为 MCP 命令，AI 可驱动代码编辑/检查。

**命令清单**：
| 命令 | 载荷 | 用途 |
|---|---|---|
| `system.code:open` | `{ path }` | 打开代码文件标签 |
| `system.code:write` | `{ path, content }` | 写文件内容（自动保存链路） |
| `system.code:get-hover` | `{ path, line, col }` | 查类型/文档（AI 检查 API 用法） |
| `system.code:get-diagnostics` | `{ path? }` | 查诊断（编译错误/类型错误） |
| `system.code:format` | `{ path }` | 格式化文件 |
| `system.code:find-refs` | `{ path, line, col }` | 查引用（重命名前评估影响） |

这些命令复用现有 MCP 命令注册机制（`core.mcpCommands.register` + 命令回传主进程）。

## 4. 落地路线

### 阶段 1：Monaco 嵌入与基础编辑（1 周）
- 引入 `monaco-editor` npm 依赖（app workspace）
- 写 `CodeEditor` 组件，挂载 Monaco，绑定 Monaco language ↔ 文件后缀
- 接入 `core.editors.register('system.code', CodeEditor)`，资源管理器双击 .ts 打开标签
- 自动保存链路（防抖 300ms → writeFile）
- 静态检查：Monaco 基础语法高亮可用（无 tsserver）

**验收**：能在 IDE 内打开 .ts 文件、编辑、看到语法高亮、保存到磁盘。

### 阶段 2：tsserver 子进程接入（1 周）
- 主进程：`TsServerManager`（spawn `tsserver.js`，stdio 通信，生命周期管理）
- 主进程：`TypeScriptServiceHost`（IPC `ts:command`/`ts:event` 桥接 tsserver stdio）
- 渲染进程：`TypeScriptService` 单例（IPC 调用 + 请求/响应配对 + 超时）
- 项目根目录传给 tsserver，`configure` 设默认编译选项
- 渲染进程：`MonacoTsAdapter` 注册 hover/completion/diagnostics 三个 provider

**验收**：在 .ts 文件里 hover 显示类型，输入 `engine.` 自动补全 API，写错类型显示红色波浪线。

### 阶段 3：完整语言特性（1 周）
- 补全 provider：definition / references / rename / format / signature help
- 诊断实时推送（tsserver 事件 → Monaco marker）
- 项目内跨文件类型解析（import 别的脚本文件，跳转/补全可用）
- MCP 命令注册（`system.code:*`）

**验收**：F12 跳转定义、Shift+F12 查引用、F2 重命名跨文件生效；AI 通过 MCP 命令能查诊断、能写文件。

### 阶段 4：引擎类型与脚本场景打通（与引擎业务层并行）
- 引擎包发布 `engine.d.ts`
- tsserver 配置 typeRoots 包含 `@liteweave/engine`
- 脚本作者写 `import { engine } from '@liteweave/engine'`，全程智能提示
- 第一个 demo 脚本（角色移动：输入事件 → 修改速度参数）跑通编辑体验

**验收**：脚本作者从新建 .ts 到写出能跑的移动脚本，全程有类型提示，零 tsconfig 知识。

### 阶段 5（可选）：WGSL 语法支持
- 注册 Monarch 语法定义 for WGSL
- 着色器文件有基础高亮（无 tsserver，WGSL 没有 LSP 实现）
- 后续若需 WGSL LSP，可接 `wgsl-analyzer`（社区项目）走同一 LanguageFeatureRegistry

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| Monaco 体积大（~3MB gzip） | Electron 应用可接受；按需加载（首次打开代码文件才 import） |
| tsserver 启动慢（大项目 5-10s） | 启动时显示加载状态；tsserver 跨标签共享，只启动一次 |
| IPC 往返延迟影响补全响应 | 渲染进程侧防抖 + 缓存；补全列表预触发（输入 `.` 时预取） |
| tsserver 与磁盘文件状态不一致 | 保存即同步；监听 tsserver `projectsUpdatedInBackground` 事件刷新 |
| Monaco worker 在 Electron 内 CSP 报错 | 用 `monaco-editor/esm/vs/editor/editor.worker` 显式 worker 入口；打包配置 worker 路径 |
| tsserver 子进程崩溃 | `TsServerManager` 监听 exit 事件自动重启；重启后通知渲染进程清缓存 |
| 多窗口共用 tsserver 状态混乱 | tsserver 单进程多项目支持（`projectName` 区分）；当前单窗口场景不暴露 |

## 6. 与既有架构的契合点

- **插件系统**：CodeEditor 作为 `system.code` 资源类型的编辑器注册，复用 `core.editors.register` 机制
- **资源协议**：.ts/.js/.wgsl 文件就是普通资源，走 `project:file:*` IPC channel，无需新协议
- **标签页**：复用 WorkspaceTabs，CodeEditor 是其中一种 tab.type 的渲染器
- **历史模块**：CodeEditor 接入 `core.history`（undo/redo 走 Monaco 自带 + 快照式历史），与 LangEditor 一致
- **MCP 命令**：`system.code:*` 命令注册到 `core.mcpCommands`，自动暴露为独立 MCP tools
- **命名空间**：命令用 `system.code:` 前缀，遵循既有命名空间隔离约定
- **自动保存**：与 LangEditor / ProjectConfigEditor 一致，编辑即落盘

## 7. 不做的事（范围红线）

- **不做 VSCode 工作区概念**：LiteWeave 是项目级 IDE，一个项目一个根目录，不引入多根工作区
- **不做 Git 集成**：版本管理交给外部工具
- **不做调试器**：脚本调试走 DevTools（Electron 自带），不集成 debug adapter
- **不做扩展市场**：LiteWeave 自己的插件系统是扩展机制，不复用 VSCode 扩展
- **不做 LSP 通用框架**：先专做 tsserver，未来多语言时再考虑抽象 LSP 框架（YAGNI）

## 8. 后续：与"引擎业务层 + Web 后端"的接口

本文档定义代码编辑能力，**引擎业务层**消费 TypeScript 代码作为脚本运行时。两文档的接口约定：

- 引擎暴露 `engine.d.ts`，定义 `engine.set / engine.on / engine.emit` 等脚本 API
- tsserver 通过 typeRoots 知道 `@liteweave/engine` 类型
- 脚本编辑期（Monaco + tsserver）= 静态类型检查
- 脚本运行期（独立 Runner 窗口，详见第 10 节）= 动态执行
- 同一份 TS 代码，编辑期和运行期看同一个类型契约

引擎业务层的设计文档（`docs/design/engine-layer.md`，待写）会定义：
- 业务层 / 后端接口边界（RenderBackend 等）
- 资源协议（.scene / .pipeline / .script）的字段
- 脚本运行时 API（与 engine.d.ts 一一对应）
- Web 后端实现（Canvas2D）
- **Runner 窗口与 IDE 窗口的协议**（详见第 10 节）

两文档通过 `engine.d.ts` 这份契约文件衔接，互不耦合。

## 9. 参考实现

- **VSCode TypeScript 扩展**：`vscode-languageserver-node` 仓库的 `tsserver` 适配，最权威参考
- **monaco-typescript**：Monaco 自带的 TS 集成，了解 provider 接口形态（不直接复用，参考 API）
- **Theia TypeScript 扩展**：Eclipse Theia 的 tsserver 集成，LSP 转换层可参考
- **Coc-tsserver**：Vim/Neovim 的 tsserver 集成，子进程管理参考

## 10. 双窗口模型：IDE 预览 vs Runner 调试

> 状态：架构补丁（2026-10-27）
> 决策：**IDE 窗口只做编辑与静态预览，不运行游戏脚本**；**Runner 是独立 Electron 进程窗口**，由 IDE 一键拉起承载真实游戏场景执行与脚本运行时。
>
> 修正第 8 节早期表述"脚本运行期（引擎业务层 + V8）"——明确 V8 跑在 Runner 进程，**不在 IDE 渲染进程内**。

### 10.1 为什么必须分离

之前设计里隐含"IDE 内嵌引擎预览面板 + vm.Context 跑脚本"，存在三重问题：

| 问题 | 后果 |
|---|---|
| 脚本崩 → IDE 渲染进程崩 | 用户编辑的未保存状态丢失（虽然编辑即落盘但 UI 状态/标签/历史栈会丢） |
| 脚本死循环 → IDE 卡死 | 用户无法停止，必须强制结束进程，编辑上下文丢失 |
| 引擎业务层与 IDE 同进程 | 引擎迭代影响 IDE 稳定；引擎使用 fs/network/child_process 等 Node API 与 IDE 安全模型冲突 |

游戏脚本是**用户写的不可信代码**，与 IDE 自身代码同进程是架构反模式。Unity / Godot 的"游戏预览"也是独立进程/线程，IDE 自身不直接执行游戏逻辑。

### 10.2 双窗口职责切分

```
┌────────────────────────────────────────────┐     ┌─────────────────────────────────────┐
│  IDE 窗口（编辑器进程，长生命周期）          │     │  Runner 窗口（运行时进程，按需启动）  │
│                                             │     │                                     │
│  - Monaco 代码编辑                          │     │  - 引擎业务层（资源加载/场景图/       │
│  - tsserver 子进程（语言服务）              │     │    pipeline 求值/物理插值）           │
│  - 资源管理器 / Schema 表单编辑             │     │  - 脚本运行时（V8 vm.Context）        │
│  - 历史模块（撤销/重做快照）                │     │  - Web 后端（Canvas2D / WebGL）       │
│  - **静态预览面板**：                       │     │  - 游戏窗口（Canvas 全屏）            │
│    只读渲染当前 .scene 一帧                 │     │  - 输入事件采集（键鼠/手柄）           │
│    不跑脚本、不跑物理、不跑 rAF             │     │  - 主循环（rAF / fixed timestep）     │
│    目的：可视化确认场景结构                 │     │                                     │
│  - MCP 命令通道（AI 操作 IDE）              │     │  不做：编辑/UI/资源管理              │
│                                             │     │  不做：MCP 命令接收（被动接收即可）   │
│  不做：跑游戏脚本                           │     │                                     │
│  不做：跑物理/rAF 主循环                    │     │                                     │
└────────────────────────────────────────────┘     └─────────────────────────────────────┘
                       │                                            ▲
                       │  IPC（项目根路径 + 启动参数）               │
                       └──────────────  一键启动  ──────────────────┘
                       │                                            │
                       │  IPC（运行时状态回传）                      │
                       ◀──────────────  状态推送  ───────────────────┘
                            （日志/性能/脚本事件/异常）
```

### 10.3 静态预览 vs Runner 调试

**静态预览（IDE 内）**：
- 资源管理器选中 .scene 文件 → IDE 内开预览标签
- 引擎业务层**渲染单帧**到 canvas（无脚本、无物理、无主循环）
- 用途：可视化确认场景结构（节点树、变换、pipeline 配置是否合理）
- 安全：业务层不跑用户脚本，不可能崩 IDE
- 实现：业务层暴露 `renderSceneOnce(scene, canvas)` API，IDE 调一次

**Runner 调试（独立窗口）**：
- 工具栏"运行"按钮 / F5 / MCP 命令 `system.runner:start` → 启动 Runner 进程
- Runner 加载项目根 + entry 场景 → 跑主循环 + 脚本 + 物理 → 真实游戏画面
- 用途：调试游戏逻辑、测试脚本行为、跑通完整数据驱动闭环
- 隔离：Runner 崩溃不影响 IDE，IDE 可重启 Runner
- 实现：`Runner 窗口` = 独立 Electron BrowserWindow，加载 runner 入口 HTML，跑引擎业务层 + 用户脚本

### 10.4 Runner 进程模型

**进程形态**：独立 Electron BrowserWindow（`webPreferences: { sandbox: false, nodeIntegration: true, contextIsolation: false }`）
- 引擎业务层需要 `fs` 读资源、`child_process` 等能力（Web 后端除外，但 native 后端需要）
- 脚本运行时用 `vm.Context` 隔离用户脚本，但 vm.Context 仍在 Runner 进程内（崩溃由 Runner 承担，IDE 不受影响）

**启动协议**：IDE 通过 IPC 告知主进程"启动 Runner"，主进程创建 BrowserWindow 并加载 `runner.html?project=<path>&scene=<path>&entry=<script>`。Runner 自己加载项目、解析场景、跑主循环。

**生命周期**：
- IDE 关闭项目 → 主动关闭 Runner（Runner 不能脱离 IDE 独活）
- Runner 崩溃 → IDE 显示"Runner 已退出"状态，提供"重启 Runner"按钮
- IDE 退出 → Runner 一并退出

### 10.5 IDE ↔ Runner 通信

**IPC channel**：
| channel | 方向 | 用途 |
|---|---|---|
| `runner:start` | IDE → 主进程 | 启动 Runner（参数：项目根/entry 场景/entry 脚本） |
| `runner:stop` | IDE → 主进程 | 停止 Runner（关闭窗口） |
| `runner:reload` | IDE → 主进程 | 重载场景（资源修改后热重载） |
| `runner:status` | Runner → IDE | 状态推送（运行中/暂停/退出/异常） |
| `runner:console` | Runner → IDE | 控制台输出转发（在 IDE 内显示 Runner 日志） |
| `runner:inspect` | IDE → Runner | 查询引擎内部状态（AI 调试用，比如当前场景节点树） |

**调试通道**：Runner 窗口可独立打开 DevTools（开发者菜单或快捷键）。脚本断点调试走 Runner 自己的 DevTools，不污染 IDE 窗口。

### 10.6 MCP 命令

| 命令 | 用途 |
|---|---|
| `system.runner:start` | 启动 Runner（载荷：`{ entryScene?, entryScript? }`） |
| `system.runner:stop` | 停止 Runner |
| `system.runner:reload` | 热重载当前场景 |
| `system.runner:status` | 查询状态 |
| `system.runner:console` | 拉取最近 N 条 Runner 日志 |
| `system.runner:inspect` | 查询引擎内部状态（节点树/参数值） |

AI 通过这些命令可以驱动完整调试循环：写脚本 → 启动 Runner → 看日志/状态 → 改脚本 → reload → 复测。

### 10.7 与静态预览面板的关系

**两者都消费引擎业务层，但用法不同**：

| | 静态预览面板（IDE 内） | Runner 窗口（独立进程） |
|---|---|---|
| 进程 | IDE 渲染进程 | 独立 Electron 进程 |
| 调用 | `engine.renderSceneOnce(scene, canvas)` | `engine.run({ project, entry, canvas })` 完整主循环 |
| 跑脚本 | 否 | 是（vm.Context） |
| 跑物理 | 否（可选简化版） | 是 |
| 主循环 | 无（仅渲染一次） | rAF / fixed timestep |
| 用户输入 | 不采集 | 采集（键鼠/手柄） |
| 用途 | 看场景结构 | 跑游戏 |
| 崩溃影响 | 不会崩（不跑用户代码） | 仅 Runner 崩，IDE 不受影响 |

业务层 API 设计要明确区分两种用法：
- `renderSceneOnce(scene: Scene, canvas: HTMLCanvasElement): void` —— 给 IDE 预览用
- `run(config: RunConfig): Runner` —— 给 Runner 用，返回 Runner 控制器（pause/resume/stop/inspect）

### 10.8 落地路线补丁

在原 5 阶段路线基础上追加阶段 6：

**阶段 6：Runner 窗口与一键调试（2 周）**
- 主进程：`RunnerWindowManager`（创建/管理 Runner BrowserWindow，IPC 桥接）
- 主进程：`runner:start/stop/reload/status/console/inspect` IPC channel
- Runner 入口：`runner.html` + `runner.ts`（加载项目、跑引擎业务层主循环）
- IDE 内：工具栏"运行"按钮 + 命令绑定 + Runner 状态指示器 + Runner 控制台面板
- MCP 命令：`system.runner:*` 注册

**验收**：F5 一键拉起 Runner 窗口跑当前 entry 场景；脚本 `console.log` 在 IDE 控制台面板显示；脚本抛异常 Runner 不崩 IDE；关闭项目 Runner 自动关闭。

### 10.9 与第 7 节"不做的事"的关系

第 7 节写"不做调试器，脚本调试走 DevTools（Electron 自带）"——本节澄清：**Runner 窗口自带 DevTools**（Electron 默认能力），用户在 Runner 窗口按 F12 / Ctrl+Shift+I 打开。IDE 不集成 debug adapter，但 IDE 接收 Runner 的 console 输出做轻量日志面板（不是断点调试器，是日志查看）。

如未来需要 IDE 内断点调试（在 Monaco 里下断点 → Runner 命中断点），再考虑集成 debug adapter（chrome-devtools-protocol 或自研）。当前阶段日志面板够用。
