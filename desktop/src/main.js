/**
 * LiteWeave 桌面壳 —— Electron 主进程。
 *
 * 职责：
 * - 创建窗口，加载渲染进程页面（开发：Vite dev server；生产：app/dist/index.html）
 * - 承载业务服务（用户方向：后端在 Electron 不需要 Express）：
 *   esbuild 把 server/src 纯逻辑打成 desktop/dist/services.mjs，主进程直接持有
 *   JsonFileStore / AiChatService，渲染进程经 IPC（endpoint+JSON 协议）调用。
 * - 项目管理：受管理工作区（~/.liteweave/projects/），list/create/open/close/
 *   import/export/remove；导入导出用 .liteweave（zip）包；不再打开任意磁盘目录
 * - 家目录 ~/.liteweave：settings + projects 都收拢到这里，启动时确保存在并迁移旧设置
 * - 通过 preload 的 contextBridge 把安全 API 暴露给渲染进程
 *
 * 协议统一 endpoint+JSON：request/subscribe/invoke 三通道（见 preload.js）。
 * 未来 Web 移植只是传输层换 fetch/EventSource，业务层不感知。
 *
 * 调试：dev 模式自动开启 --remote-debugging-port=9222，可用 chrome-devtools MCP
 * 通过 --browserUrl http://127.0.0.1:9222 连接调试（与 Chrome 同机制）。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { createServer as createHttpServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  initServices,
  disposeServices,
  handleRequest,
  handleSubscribe,
  handleUnsubscribe,
  wireStorePush,
} from './services.js'
import { createProjectManager, PROJECT_PACKAGE_EXT } from './projectManager.js'
// Runner 窗口管理（独立 Electron 进程，承载引擎业务层主循环；见 docs/design/monaco-tsserver.md §10）
import { createRunnerWindowManager } from './runnerWindowManager.js'
// 内嵌 MCP server：Electron 主进程提供 HTTP /mcp（relay 转发目标），命令经 onCommand 推给渲染进程
import { LiteweaveMcpServer, createMcpHttpHandler } from '../dist/services.mjs'
import { z } from 'zod'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 是否开发模式（electron . --dev）
const isDev = process.argv.includes('--dev')

/** LiteWeave 家目录（~/.liteweave）：settings + projects 都收拢到这里 */
const HOME_DIR = path.join(os.homedir(), '.liteweave')

/** 服务层是否已就绪 */
let servicesReady = false

/** 渲染进程页面入口 */
function rendererUrl() {
  if (isDev) {
    return process.env.VITE_DEV_URL ?? 'http://localhost:5173'
  }
  // 生产：加载构建产物
  return path.join(__dirname, '../../app/dist/index.html')
}

/** Runner 窗口页面入口（dev：Vite dev server runner.html；prod：构建产物） */
function runnerUrl() {
  if (isDev) {
    const base = process.env.VITE_DEV_URL ?? 'http://localhost:5173'
    return `${base}/runner.html`
  }
  return path.join(__dirname, '../../app/dist/runner.html')
}

/**
 * 读取目录树（递归、限深度、跳过常见噪声目录）。
 * 根固定为项目目录（不再暴露任意磁盘路径）。
 */
async function readDirTree(root, depth = 0, maxDepth = 8, baseDir = root) {
  if (depth > maxDepth) return []
  const entries = await fs.readdir(root, { withFileTypes: true })
  const nodes = []
  for (const entry of entries) {
    // 跳过隐藏文件/目录与常见噪声
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    // 跳过项目元数据 project.json（项目根级；通过 文件→项目配置 菜单打开编辑，不在资源树暴露）
    if (entry.name === 'project.json' && depth === 0) continue
    const fullPath = path.join(root, entry.name)
    // 虚拟路径：相对项目根 baseDir，/ 分隔（IDE 语义，前端/协议侧不暴露绝对路径）
    const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/')
    const node = {
      name: entry.name,
      path: relPath,
      type: entry.isDirectory() ? 'directory' : 'file',
    }
    if (entry.isDirectory()) {
      node.children = await readDirTree(fullPath, depth + 1, maxDepth, baseDir)
    }
    nodes.push(node)
  }
  // 目录优先、字母排序
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

/**
 * 迁移旧 settings（userData/settings.json）到新家目录（~/.liteweave/settings.json）。
 * 仅当旧路径存在、新路径不存在时复制一次。
 */
async function migrateLegacySettings() {
  const legacyDir = app.getPath('userData')
  const legacyFile = path.join(legacyDir, 'settings.json')
  const newFile = path.join(HOME_DIR, 'settings.json')
  try {
    await fs.mkdir(HOME_DIR, { recursive: true })
    await fs.access(legacyFile)
    try {
      await fs.access(newFile)
    } catch {
      // 新路径不存在 → 复制旧配置
      await fs.copyFile(legacyFile, newFile)
      console.log(`[desktop] 已迁移旧设置: ${legacyFile} → ${newFile}`)
    }
  } catch (err) {
    // 旧路径不存在或迁移失败：不阻断启动
    if (err.code !== 'ENOENT') {
      console.warn('[desktop] 设置迁移跳过:', err.message)
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    title: 'LiteWeave',
    backgroundColor: '#1c2127',
    // 应用内已有 MenuBar（前端组件），隐藏 Electron 默认原生菜单栏
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 彻底禁用 Electron 默认原生菜单（autoHideMenuBar 仅隐藏，按 Alt 仍会唤出）。
  // 设为 null 后默认菜单的快捷键（含 Ctrl-R/F5 刷新、Ctrl-Shift-I 开 DevTools）也失效。
  Menu.setApplicationMenu(null)

  // 兜底拦截刷新快捷键：Menu.setApplicationMenu(null) 已让默认菜单失效，
  // 但 Chromium 内置 keybinding 在某些版本仍可能响应，这里硬拦 before-input-event。
  win.webContents.on('before-input-event', (event, input) => {
    // 禁用 Ctrl-R / Ctrl-Shift-R / F5 刷新（防止用户误触丢未保存数据）
    if (
      (input.key.toLowerCase() === 'r' && (input.control || input.meta)) ||
      input.key === 'F5'
    ) {
      event.preventDefault()
    }
  })

  // 收集渲染进程 console 日志（供 MCP debug_console 读取）
  watchRendererConsole(win)

  // IDE 是主入口：IDE 关闭时主动退出整个 app。
  // 否则 Runner 作为独立 BrowserWindow 会让 window-all-closed 永不触发，
  // 导致单独关 IDE 后 Runner 残留累积（每次重启 IDE 留一个 Runner 进程）。
  // app.quit() 触发后 Electron 销毁所有 BrowserWindow（含 Runner），无需显式 stop。
  win.once('closed', () => {
    app.quit()
  })

  if (isDev) {
    void win.loadURL(rendererUrl())
    // 打开 DevTools
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(rendererUrl())
  }

  return win
}

/* ---------------- IPC：传输层（endpoint + JSON 协议） ---------------- */

// REST 语义请求：渲染进程 window.liteweave.request(method, path, body)
ipcMain.handle('transport:request', async (_event, req) => {
  const { method, path: p, body } = req ?? {}
  try {
    return await handleRequest(method, p, body)
  } catch (err) {
    console.error(`[transport] ${method} ${p} failed:`, err)
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

// 订阅服务端推送：返回订阅 id（渲染进程 window.liteweave.subscribe）
ipcMain.on('transport:subscribe', (event, path) => {
  const subId = handleSubscribe(path)
  // sendSync 需要同步返回，这里用 event.returnValue
  event.returnValue = subId
})

// 取消订阅
ipcMain.on('transport:unsubscribe', (_event, subId) => {
  handleUnsubscribe(subId)
})

/* ---------------- MCP server（内嵌，Electron 提供 HTTP /mcp） ---------------- */

/**
 * MCP HTTP server 监听端口（调试端口，可配置）：
 * 优先环境变量 LITEWEAVE_MCP_PORT，其次 ~/.liteweave/settings.json 的 mcp.port，默认 3001。
 */
async function resolveMcpPort() {
  if (process.env.LITEWEAVE_MCP_PORT) {
    const n = Number(process.env.LITEWEAVE_MCP_PORT)
    if (Number.isInteger(n) && n > 0) return n
  }
  try {
    const raw = await fs.readFile(path.join(HOME_DIR, 'settings.json'), 'utf8')
    const settings = JSON.parse(raw)
    const port = settings?.mcp?.port
    if (Number.isInteger(port) && port > 0) return port
  } catch {
    // 文件不存在/损坏 → 用默认
  }
  return 3001
}

/**
 * MCP 可执行命令清单（静态维护；渲染进程 CommandBus 对未知命令宽松兜底）。
 * 每条命令会注册为独立 MCP 工具（system_project_open 等），带各自 args schema；
 * run_command 仍保留作动态命令兜底。
 */
const MCP_COMMANDS = [
  { name: 'system.project:open', description: '打开项目', schema: { id: z.string().describe('项目 id') } },
  {
    name: 'system.project:create',
    description: '新建项目并打开',
    schema: {
      name: z.string().describe('项目名'),
      type: z.enum(['2d', '3d']).optional().describe('项目类型，默认 2d'),
      defaultNamespace: z.string().optional().describe('默认命名空间（默认=项目名小写）'),
    },
  },
  { name: 'system.project:close', description: '关闭当前项目' },
  { name: 'system.project:import', description: '导入 .liteweave 项目包（弹系统文件框）' },
  { name: 'system.project:export', description: '导出项目为 .liteweave 包', schema: { id: z.string().optional().describe('项目 id（缺省当前项目）') } },
  { name: 'system.project:remove', description: '删除项目', schema: { id: z.string().describe('项目 id') } },
  {
    name: 'system.project:config:set',
    description: '写 project.json 配置（可视化配置编辑器 / AI 共用链路）',
    schema: { patch: z.record(z.unknown()).describe('嵌套补丁对象，深合并到 project.json，如 { settings: { rendering: { targetFps: 75 } } }') },
  },
  { name: 'system.settings:set', description: '写入设置字段', schema: { key: z.string().describe('设置路径，如 ui.locale'), value: z.unknown().describe('值') } },
  { name: 'system.layout:set', description: '写入布局字段', schema: { key: z.string().describe('布局路径，如 sidebar.width'), value: z.unknown().describe('值') } },
  { name: 'system.i18n:setLocale', description: '切换界面语言', schema: { locale: z.string().describe('语言码，如 zh-CN / en-US') } },
  // Runner 窗口控制（AI 经 MCP 驱动引擎业务层窗口）
  {
    name: 'system.runner:start',
    description: '启动 Runner 窗口（独立进程，承载引擎业务层主循环）。缺省 projectId 时用当前打开项目。',
    schema: {
      projectId: z.string().optional().describe('项目 id（缺省=当前打开项目）'),
      projectName: z.string().optional().describe('项目名（缺省自动补全）'),
      projectRoot: z.string().optional().describe('项目根目录绝对路径（缺省自动补全）'),
      entryScript: z.string().optional().describe('入口脚本路径'),
    },
  },
  { name: 'system.runner:stop', description: '停止 Runner 窗口（关闭进程）' },
  { name: 'system.runner:reload', description: '重载 Runner（保留窗口，重新加载页面 + 重注入 bootstrap）' },
  { name: 'system.runner:status', description: '查询 Runner 当前状态（status/projectId/alive 等）' },
]

/**
 * MCP 命令落地。
 *
 * 两种路径：
 * 1. system.runner:* —— 主进程直接处理（Runner 是进程级资源，主进程权威；不需要绕渲染进程）
 * 2. 其它命令 —— 推给所有 IDE 窗口的渲染进程执行（渲染进程订阅 mcp:command → runCommand）
 */
async function onMcpCommand(command, args) {
  // Runner 命令：主进程直连 RunnerWindowManager
  if (command === 'system.runner:start') {
    // 与 IPC runner:start 同语义：启 Runner 窗口
    try {
      const status = await startRunner(args ?? {})
      return JSON.stringify(status)
    } catch (err) {
      return `Runner 启动失败: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (command === 'system.runner:stop') {
    await runnerManager.stop()
    return 'Runner 已停止'
  }
  if (command === 'system.runner:reload') {
    try {
      const status = await reloadRunner()
      return JSON.stringify(status)
    } catch (err) {
      return `Runner 重载失败: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (command === 'system.runner:status') {
    return JSON.stringify(runnerManager.getStatus())
  }

  // 其它命令：推给 IDE 渲染进程执行
  const windows = BrowserWindow.getAllWindows()
  if (windows.length === 0) return '编辑器窗口未打开'
  for (const win of windows) {
    win.webContents.send('mcp:command', { command, args })
  }
  return `命令已推送到编辑器：${command}`
}

/**
 * 把渲染进程回传的结构化命令参数 schema（McpArgSchema）转成 zod schema。
 * 渲染进程不共享 zod 实例，用结构化描述（type/optional/enum/description），主进程在此转 zod。
 */
function argSchemaToZod(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const shape = {}
  for (const [key, def] of Object.entries(args)) {
    if (!def || typeof def !== 'object') continue
    let schema
    switch (def.type) {
      case 'number':
        schema = z.number()
        break
      case 'boolean':
        schema = z.boolean()
        break
      case 'object':
        schema = z.record(z.string(), z.unknown())
        break
      case 'string':
      default:
        schema = z.string()
        if (Array.isArray(def.enum) && def.enum.length > 0) schema = z.enum(def.enum)
    }
    if (typeof def.description === 'string' && def.description) {
      schema = schema.describe(def.description)
    }
    shape[key] = def.optional ? schema.optional() : schema
  }
  return shape
}

/** 当前 MCP server 实例（mcp:commands:sync 时更新命令清单） */
let mcpServerRef = null

/** MCP HTTP server 实例（退出时需 close 释放事件循环引用，否则主进程不退） */
let mcpHttpServerRef = null

/** 渲染进程同步早于 MCP server 就绪时暂存（startMcpServer 就绪后补同步） */
let pendingMcpCommands = null

// 渲染进程回传 MCP 命令清单（单一来源在前端）：把新命令注册为独立 MCP 工具（幂等）
ipcMain.handle('mcp:commands:sync', (_event, payload) => {
  const commands = payload?.commands
  if (!Array.isArray(commands)) {
    return { ok: false, error: '命令清单无效' }
  }
  const defs = commands
    .filter((c) => c && typeof c.name === 'string' && c.name)
    .map((c) => ({
      name: c.name,
      description: typeof c.description === 'string' ? c.description : '',
      schema: argSchemaToZod(c.args),
    }))
  if (!mcpServerRef) {
    // MCP server 尚未启动（渲染进程可能先就绪）：暂存，startMcpServer 就绪后补同步
    pendingMcpCommands = defs
    return { ok: true, queued: true, count: defs.length }
  }
  mcpServerRef.syncCommands(defs)
  console.log(`[mcp] 已同步 ${defs.length} 条命令清单（来自渲染进程）`)
  return { ok: true, count: defs.length }
})

/** 应用暂存的命令清单（startMcpServer 就绪后调用） */
function applyPendingMcpCommands() {
  if (!pendingMcpCommands || !mcpServerRef) return
  mcpServerRef.syncCommands(pendingMcpCommands)
  console.log(`[mcp] 已补同步 ${pendingMcpCommands.length} 条暂存命令清单`)
  pendingMcpCommands = null
}

/* ---------------- MCP 调试工具集（替代 cdp-probe / chrome-devtools 做日常调试） ---------------- */

/** 渲染进程 console 日志环形缓冲（debug_console 读取） */
const consoleRing = []
const CONSOLE_RING_MAX = 200

/** 把日志条目 push 进环形缓冲（统一入口） */
function pushConsoleRing(entry) {
  consoleRing.push(entry)
  if (consoleRing.length > CONSOLE_RING_MAX) consoleRing.splice(0, consoleRing.length - CONSOLE_RING_MAX)
}

// 拦截主进程 console.log/warn/error，注入 consoleRing（source: 'main'）
// 这样 MCP debug_console 能查到 Electron 主进程日志（IPC handler/服务层/文件服务等）
const _origLog = console.log.bind(console)
const _origWarn = console.warn.bind(console)
const _origError = console.error.bind(console)
console.log = (...args) => { pushConsoleRing({ level: 'info', message: args.map(String).join(' '), source: 'main' }); _origLog(...args) }
console.warn = (...args) => { pushConsoleRing({ level: 'warning', message: args.map(String).join(' '), source: 'main' }); _origWarn(...args) }
console.error = (...args) => { pushConsoleRing({ level: 'error', message: args.map(String).join(' '), source: 'main' }); _origError(...args) }

/** 收集各窗口渲染进程的 console 日志到环形缓冲（兼容新旧事件签名） */
function watchRendererConsole(win) {
  win.webContents.on('console-message', (_event, levelOrDetails, message, line, sourceId) => {
    const levels = ['verbose', 'info', 'warning', 'error']
    let entry
    if (typeof levelOrDetails === 'object' && levelOrDetails !== null) {
      // 新版：MessageDetails 对象
      entry = {
        level: levels[levelOrDetails.level] ?? String(levelOrDetails.level),
        message: levelOrDetails.message,
        line: levelOrDetails.lineNumber,
        source: levelOrDetails.sourceUrl || levelOrDetails.source,
      }
    } else {
      // 旧版：位置参数 (level, message, line, sourceId)
      entry = {
        level: levels[levelOrDetails] ?? String(levelOrDetails),
        message,
        line,
        source: sourceId,
      }
    }
    pushConsoleRing(entry)
  })
}

/** 主渲染窗口（IDE 编辑器窗口；排除 Runner 窗口与 devtools） */
function mainRendererWindow() {
  const wins = BrowserWindow.getAllWindows()
  // 优先返回非 Runner 的编辑器窗口；找不到再回退首个窗口
  return wins.find((w) => !w.webContents.getURL().includes('runner.html')) ?? wins[0] ?? null
}

/** MCP 调试工具：注册到 LiteweaveMcpServer（依赖 webContents/BrowserWindow，主进程专属） */
function registerMcpDebugTools(mcp) {
  mcp.registerDebugTool(
    'debug_get_state',
    '查看 LiteWeave 运行状态：窗口数量 + 每窗口 URL/标题/是否加载完成/是否最大化。诊断链路最常用。',
    async () => {
      const windows = BrowserWindow.getAllWindows()
      const hasBridge = windows[0]
        ? await windows[0].webContents.executeJavaScript(
            'Boolean(window.liteweave && typeof window.liteweave.onMcpCommand === "function")'
          ).catch(() => false)
        : false
      return {
        windows: windows.map((win) => ({
          id: win.id,
          title: win.getTitle(),
          url: win.webContents.getURL(),
          loading: win.webContents.isLoading(),
          ready: !win.webContents.isLoading(),
          maximized: win.isMaximized(),
        })),
        hasBridge,
      }
    },
  )

  mcp.registerDebugTool(
    'debug_eval',
    '在渲染进程（主世界）执行 JS 表达式/语句，返回求值结果（JSON 序列化）。可访问 DOM 与 window.liteweave。',
    async ({ expression }) => {
      const win = mainRendererWindow()
      if (!win) return { error: '无渲染窗口' }
      const result = await win.webContents.executeJavaScript(expression, true)
      return { result }
    },
  )

  mcp.registerDebugTool(
    'debug_console',
    '返回最近渲染进程 console 日志（主进程环形缓冲，最多 200 条；含 level/message/行号/来源）。',
    async ({ limit }) => {
      const n = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 50
      return { entries: consoleRing.slice(-n) }
    },
  )

  mcp.registerDebugTool(
    'debug_eval_main',
    '在主进程执行 JS 表达式/语句，返回求值结果（JSON 序列化）。可访问 BrowserWindow / process / __dirname / HOME_DIR 等主进程对象（慎用）。',
    async ({ expression }) => {
      // 把关键主进程对象注入作用域，表达式可直接使用 BrowserWindow / process / __dirname / HOME_DIR。
      // 表达式可为"值表达式"（自动 return，如 ({a:1}) / process.cwd()）或"语句体"（含 return，如 if/const/let）。
      // 注意：({...}) / (...) 是表达式（对象/分组），不是语句体，必须用 return 包裹才能返回其值。
      const body = /^\s*(return\s|await\s|if\s|\{|const\s|let\s|var\s)/.test(expression)
        ? expression
        : `return (${expression})`
      const fn = new Function(
        'BrowserWindow', 'ipcMain', 'app', 'process', '__dirname', 'HOME_DIR',
        `return (async () => { ${body} })()`,
      )
      const result = await fn(BrowserWindow, ipcMain, app, process, __dirname, HOME_DIR)
      return { result }
    },
  )

  mcp.registerDebugTool(
    'debug_screenshot',
    '截取 Runner 窗口画面（data:image/png;base64）。仅用于证明是否渲染，细节请用 debug_runner_inspect 打印渲染信息（MVP 矩阵等）。',
    async () => {
      try {
        const dataUrl = await runnerManager.capturePage()
        return { dataUrl }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  mcp.registerDebugTool(
    'debug_runner_inspect',
    '在 Runner 渲染进程主世界执行 JS 表达式，返回求值结果。用于打印渲染细节（MVP 矩阵/RO/资产等）。例：window.__renderer.inspect()',
    async ({ expression }) => {
      try {
        const result = await runnerManager.inspect(expression)
        return { result }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
}

/** 启动内嵌 MCP server（node:http，仅 /mcp endpoint） */
async function startMcpServer() {
  const port = await resolveMcpPort()
  const mcp = new LiteweaveMcpServer({
    onCommand: onMcpCommand,
    commands: MCP_COMMANDS,
  })
  mcpServerRef = mcp
  registerMcpDebugTools(mcp)
  // 渲染进程同步早于本 server 就绪的暂存命令清单，在此补同步（幂等）
  applyPendingMcpCommands()
  const handler = createMcpHttpHandler(mcp)
  const server = createHttpServer((req, res) => {
    // 只处理 /mcp（及 /mcp/ 兼容）；其它返回 404
    const url = req.url ?? ''
    const pathname = url.split('?')[0]
    if (pathname === '/mcp' || pathname === '/mcp/') {
      handler(req, res)
    } else {
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'not found' }))
    }
  })
  server.on('error', (err) => {
    console.error('[mcp] HTTP server error:', err)
  })
  server.listen(port, () => {
    console.log(`[mcp] LiteWeave MCP server listening on http://localhost:${port}/mcp`)
  })
  mcpHttpServerRef = server
  return server
}

/* ---------------- 窗口控制 ---------------- */

// 进入编辑器时自动最大化（编辑窗口习惯上最大化；前端 PROJECT_OPENED 后调用）
ipcMain.handle('window:maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  win?.maximize()
  return { ok: true }
})

// 关闭项目回到启动器时恢复窗口大小（前端 PROJECT_CLOSED 后调用；若本就没最大化则无操作）
ipcMain.handle('window:restore', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win?.isMaximized()) win.unmaximize()
  return { ok: true }
})

/* ---------------- 项目管理（受管理工作区 ~/.liteweave/projects/） ---------------- */

const projectManager = createProjectManager()

/** 弹系统文件框选 .liteweave 包，返回路径或 null */
async function pickPackageFile() {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, {
    title: '导入 LiteWeave 项目',
    filters: [{ name: 'LiteWeave 项目', extensions: [PROJECT_PACKAGE_EXT.slice(1)] }],
    properties: ['openFile'],
    buttonLabel: '导入',
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

/** 弹系统保存框，返回落点路径或 null */
async function pickSavePath(defaultName) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showSaveDialog(win, {
    title: '导出 LiteWeave 项目',
    defaultPath: defaultName,
    filters: [{ name: 'LiteWeave 项目', extensions: [PROJECT_PACKAGE_EXT.slice(1)] }],
    buttonLabel: '导出',
  })
  if (result.canceled || !result.filePath) return null
  return result.filePath
}

// 项目管理 channel（全部收拢到 ~/.liteweave/projects/，不暴露任意磁盘路径）
ipcMain.handle('project:list', async () => {
  try {
    return await projectManager.list()
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('project:create', async (_event, payload) => {
  try {
    return await projectManager.create({
      name: payload?.name,
      type: payload?.type,
      defaultNamespace: payload?.defaultNamespace,
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('project:open', async (_event, payload) => {
  try {
    return await projectManager.open({ id: payload?.id, readDirTree })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('project:close', async (_event, payload) => {
  try {
    return await projectManager.close(payload?.id)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('project:import', async () => {
  try {
    const filePath = await pickPackageFile()
    if (!filePath) return { canceled: true }
    return await projectManager.import(filePath)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('project:export', async (_event, payload) => {
  try {
    const { fileName, buffer } = await projectManager.export(payload?.id)
    const savePath = await pickSavePath(fileName)
    if (!savePath) return { canceled: true }
    await fs.writeFile(savePath, buffer)
    return { canceled: false, ok: true, path: savePath }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('project:remove', async (_event, payload) => {
  try {
    return await projectManager.remove(payload?.id)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

// project.json 配置读写（project 资源编辑器数据链路；id 必填 = 当前打开项目，防越权改其它项目）
ipcMain.handle('project:config:read', async (_event, payload) => {
  try {
    return await projectManager.readMetaConfig(payload?.id)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('project:config:write', async (_event, payload) => {
  try {
    return await projectManager.updateMeta(payload?.id, payload?.patch)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

// 通用资源文件 CRUD（虚拟路径，主进程安全校验防穿越）
ipcMain.handle('project:file:read', async (_event, payload) => {
  try {
    return await projectManager.readFile(payload?.id, payload?.path)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('project:file:write', async (_event, payload) => {
  try {
    return await projectManager.writeFile(payload?.id, payload?.path, payload?.content)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('project:file:create', async (_event, payload) => {
  try {
    return await projectManager.createFile({
      id: payload?.id,
      path: payload?.path,
      name: payload?.name,
      namespace: payload?.namespace,
      content: payload?.content,
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('project:file:delete', async (_event, payload) => {
  try {
    return await projectManager.deleteFile(payload?.id, payload?.path)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

// 通用目录 CRUD（虚拟路径，自由创建/删除）
ipcMain.handle('project:dir:create', async (_event, payload) => {
  try {
    return await projectManager.createDir({
      id: payload?.id,
      path: payload?.path,
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('project:dir:delete', async (_event, payload) => {
  try {
    return await projectManager.deleteDir({
      id: payload?.id,
      path: payload?.path,
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

// 重命名/移动文件或目录（fs.rename；同步 project.json 资源清单）
ipcMain.handle('project:rename', async (_event, payload) => {
  try {
    return await projectManager.rename({
      id: payload?.id,
      oldPath: payload?.oldPath,
      newPath: payload?.newPath,
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(async () => {
  // 家目录初始化：settings 迁移到 ~/.liteweave，随后服务层以它作为数据目录
  try {
    await migrateLegacySettings()
  } catch (err) {
    console.warn('[desktop] 家目录初始化失败:', err)
  }

  // 先启动服务层，再建窗口（渲染进程请求时服务已就绪）
  try {
    const dataDir = HOME_DIR
    await initServices({ dataDir, onPush: pushToRenderer })
    wireStorePush()
    servicesReady = true
    console.log(`[desktop] 服务层就绪，数据目录: ${dataDir}`)
  } catch (err) {
    console.error('[desktop] 服务层启动失败:', err)
  }

  createWindow()

  // 启动内嵌 MCP server（relay 转发目标：http://localhost:<port>/mcp）；
  // 独立 Web server 已停用，端口由 Electron 提供 MCP 接口（settings mcp.port / env LITEWEAVE_MCP_PORT，默认 3001）
  try {
    await startMcpServer()
  } catch (err) {
    console.error('[mcp] MCP server 启动失败:', err)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/** 把服务变更推给渲染进程（替代 SSE）：按 subId 发给所有窗口的 transport:event */
function pushToRenderer(subId, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    // 跳过 Runner 窗口：Runner 不订阅 transport:event（不连服务层），避免无关消息干扰
    if (win.webContents.getURL().includes('runner.html')) continue
    win.webContents.send('transport:event', { subId, data })
  }
}

/* ---------------- Runner 窗口（独立进程，承载引擎业务层） ---------------- */
//
// 架构（见 docs/design/monaco-tsserver.md §10 双窗口模型）：
// - IDE 主窗口只编辑 + 静态预览（renderSceneOnce）
// - Runner 是独立 BrowserWindow，跑脚本 + 主循环，崩溃不影响 IDE
// - IDE ↔ Runner 不直连，全部经主进程中转：
//     IDE ──ipc──► 主进程 runner:* ──► RunnerWindowManager ──webContents──► Runner
//     Runner ──ipc──► 主进程 runner:ready/heartbeat/console ──send──► IDE（runner:event）
//
// 单例：同一时刻只有一个 Runner 窗口。start 时若已有 Runner 会先 stop。

/** IDE 主窗口（首个非 Runner 窗口）；用于向 IDE 推送 runner 事件 */
function ideMainWindow() {
  return BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('runner.html')) ?? null
}

/** 推送 runner 事件到 IDE 主窗口 */
function pushRunnerEventToIDE(event) {
  const win = ideMainWindow()
  if (!win) return
  win.webContents.send('runner:event', event)
}

/** Runner 窗口管理器实例 */
const runnerManager = createRunnerWindowManager({
  isDev,
  runnerUrl,
  onStatusChange: (status, info) => {
    pushRunnerEventToIDE({ type: 'status', status, info: info ?? null, at: new Date().toISOString() })
  },
  onConsole: (entry) => {
    // Runner（含 Worker）console 同步进 consoleRing，供 MCP debug_console 查询
    consoleRing.push({ ...entry, source: `runner:${entry.source ?? ''}` })
    if (consoleRing.length > CONSOLE_RING_MAX) consoleRing.splice(0, consoleRing.length - CONSOLE_RING_MAX)
    pushRunnerEventToIDE({ type: 'console', entry })
  },
})

/**
 * 启动 Runner（IPC 与 MCP 路径共用）。
 * engine 已清空待重设计，当前只启 Runner 窗口（空页面），无脚本宿主。
 */
async function startRunner(bootstrap) {
  // MCP 调用可能只传 projectId（无 projectRoot/name）；缺省时从 projectManager 查盘补全
  if (!bootstrap.projectRoot && bootstrap.projectId) {
    try {
      const found = await projectManager.readMetaConfig(bootstrap.projectId)
      if (found?.project) {
        bootstrap.projectRoot = found.project.path
        bootstrap.projectName = bootstrap.projectName ?? found.project.name
        bootstrap.entryScript = bootstrap.entryScript ?? (found.project.entryScript || undefined)
      }
    } catch (err) {
      console.warn('[runner] 通过 projectId 补全 bootstrap 失败:', err.message)
    }
  }
  await runnerManager.start(bootstrap)
  return runnerManager.getStatus()
}

// 启动 Runner（IDE IPC 调用）
ipcMain.handle('runner:start', async (_event, payload) => {
  try {
    const status = await startRunner(payload ?? {})
    return { ok: true, status }
  } catch (err) {
    console.error('[runner] start 失败:', err)
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

// 停止 Runner
ipcMain.handle('runner:stop', async () => {
  try {
    await runnerManager.stop()
    return { ok: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

/**
 * 重载 Runner（保留窗口，重新加载页面）。
 * engine 已清空待重设计，当前只走 runnerManager.reload（硬 reload 页面）。
 */
async function reloadRunner() {
  await runnerManager.reload()
  return runnerManager.getStatus()
}

// 重载 Runner（保留窗口，重新加载页面）
ipcMain.handle('runner:reload', async () => {
  try {
    const status = await reloadRunner()
    return { ok: true, status }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

// 查询 Runner 状态
ipcMain.handle('runner:status', () => {
  return runnerManager.getStatus()
})

// Runner → 主进程：报告就绪
ipcMain.handle('runner:ready', async (_event, _payload) => {
  runnerManager.markReady()
  return { ok: true }
})

// Runner → 主进程：上报运行状态（渲染循环启动 → running，等）
ipcMain.handle('runner:report-status', async (_event, payload) => {
  if (payload?.status) {
    runnerManager.reportStatus(payload.status)
  }
  return { ok: true }
})

// Runner → 主进程：心跳
ipcMain.handle('runner:heartbeat', async (_event, payload) => {
  runnerManager.heartbeat(payload?.seq)
  return { ok: true }
})

// Runner → 主进程：日志转发（runner.ts 主动上报，与 webContents console-message 互补）
ipcMain.handle('runner:console', async (_event, payload) => {
  runnerManager.forwardConsole(payload)
  return { ok: true }
})

// IDE → Runner：执行表达式查询引擎内部状态（runner:inspect）
ipcMain.handle('runner:inspect', async (_event, payload) => {
  try {
    const result = await runnerManager.inspect(payload?.expression)
    return { result }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

// IDE → Runner：发送指令事件（run/pause 等，未来扩展）
ipcMain.handle('runner:send-event', async (_event, payload) => {
  runnerManager.sendToRunner(payload)
  return { ok: true }
})

// Runner → 主进程：按资产 id 读取单个资产字节（engine 文件服务后端）
// id 格式 <namespace>:<path>，主进程解析为 assets/<ns>/<path> 读磁盘。
// 主进程是纯文件服务器，不理解资产语义。payload: { projectId, assetId } → { ok, data?: Uint8Array, error? }
ipcMain.handle('runner:read-asset', async (_event, payload) => {
  try {
    const projectId = payload?.projectId
    const assetId = payload?.assetId
    if (typeof projectId !== 'string' || typeof assetId !== 'string') {
      return { error: 'invalid payload (projectId/assetId required)' }
    }
    const { buffer } = await projectManager.readAssetBytes(projectId, assetId)
    return { ok: true, data: new Uint8Array(buffer) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

// Runner → 主进程：按项目根相对路径读取业务脚本文本（dist/main.js 等）。
// 区别于 read-asset（<namespace>:<path> 限 assets/<ns>/），read-script 读项目根任意相对路径，
// 复用 projectManager.readFile（含防穿越校验）。payload: { projectId, path } → { ok, content?, error? }
ipcMain.handle('runner:read-script', async (_event, payload) => {
  try {
    const projectId = payload?.projectId
    const scriptPath = payload?.path
    if (typeof projectId !== 'string' || typeof scriptPath !== 'string') {
      return { error: 'invalid payload (projectId/path required)' }
    }
    const { content } = await projectManager.readFile(projectId, scriptPath)
    return { ok: true, content }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

// Runner → 主进程：批量加载资产字节（engine 文件服务后端，一次 invoke 返回所有）
// 开发态资产量小，简单做；后续可改流式。payload: { projectId, assetIds } → { ok, results: { [id]: Uint8Array | { error } } }
ipcMain.handle('runner:load-assets', async (_event, payload) => {
  try {
    const projectId = payload?.projectId
    const assetIds = payload?.assetIds
    if (typeof projectId !== 'string' || !Array.isArray(assetIds)) {
      return { error: 'invalid payload (projectId/assetIds required)' }
    }
    const results = {}
    await Promise.all(assetIds.map(async (id) => {
      try {
        const { buffer } = await projectManager.readAssetBytes(projectId, id)
        results[id] = new Uint8Array(buffer)
      } catch (err) {
        results[id] = { error: err instanceof Error ? err.message : String(err) }
      }
    }))
    return { ok: true, results }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

// 退出前关闭服务层 + MCP HTTP server（等待持久化写盘 + 释放事件循环引用）
// 关键：所有异步清理完成后用 app.exit(0) 强制退出，避免遗漏的 handle（如未关闭的
// EventEmitter、定时器、CDP 端口等）持有事件循环导致主进程挂起不退。
app.on('will-quit', (event) => {
  if (servicesReady) {
    event.preventDefault()
    // 关闭 MCP HTTP server（持有事件循环引用，不 close 主进程无法退出）
    if (mcpHttpServerRef) {
      const s = mcpHttpServerRef
      mcpHttpServerRef = null
      s.close(() => console.log('[mcp] HTTP server 已关闭'))
    }
    disposeServices()
      .catch((err) => console.error('[desktop] 服务层关闭失败:', err))
      .finally(() => {
        servicesReady = false
        // app.exit 强制退出（绕过 will-quit 二次触发 + 残留 handle 卡事件循环）
        app.exit(0)
      })
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// dev 模式开启远程调试端口，供 chrome-devtools MCP 连接
if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
  // 允许任意 origin 连 CDP（python websocket-client / chrome-devtools MCP 等）
  app.commandLine.appendSwitch('remote-allow-origins', '*')
}
