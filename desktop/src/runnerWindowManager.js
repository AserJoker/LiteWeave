/**
 * RunnerWindowManager —— Runner 窗口的生命周期管理。
 *
 * 定位（见 docs/design/monaco-tsserver.md §10 双窗口模型）：
 * - Runner 是独立 Electron BrowserWindow，跑引擎业务层主循环 + 脚本
 * - 与 IDE 主窗口进程隔离：Runner 崩溃/卡死不影响 IDE 编辑器
 * - 单例：同一时刻只有一个 Runner 窗口（再次 start 会先 stop 旧的）
 *
 * 与 IDE 的通讯链路（不直连，全部经主进程中转）：
 *   IDE ──ipc──► 主进程 runner:start/stop/reload ──► 本管理器 ──webContents──► Runner
 *   Runner ──ipc──► 主进程 runner:ready/heartbeat/console ──webContents.send──► IDE（runner:event）
 *
 * Bootstrap 注入：创建窗口时把项目信息（id/name/root + entryScene/entryScript）
 * 序列化成 base64 JSON 放到 URL query（?bootstrap=...），Runner preload 同步解析。
 *
 * 崩溃恢复：监听 'closed' / 'render-process-gone' → 标记 stopped → 通知 IDE 显示"重启"按钮。
 */
import { BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Runner 窗口状态（推送给 IDE 显示指示器） */
const RunnerStatus = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  READY: 'ready',
  RUNNING: 'running',
  ERROR: 'error',
})

/**
 * 创建 RunnerWindowManager。
 *
 * @param {{ isDev: boolean, rendererUrl: () => string, runnerUrl: () => string, onStatusChange: (status: string, info?: object) => void, onConsole: (entry: object) => void, onInspect: (result: unknown) => void }} opts
 *   - isDev：开发模式（开 Runner DevTools）
 *   - runnerUrl：Runner 页面 URL（dev: Vite dev server runner.html；prod: 文件路径）
 *   - onStatusChange：状态变化回调（推送给 IDE）
 *   - onConsole：Runner console 日志回调（推送给 IDE 控制台面板）
 */
export function createRunnerWindowManager(opts) {
  const { isDev, runnerUrl, onStatusChange, onConsole } = opts

  /** 当前 Runner 窗口实例（单例） */
  let runnerWin = null
  /** 当前 Runner 承载的项目信息（用于 reload 时重新注入 bootstrap） */
  let currentBootstrap = null
  /** 当前状态 */
  let status = RunnerStatus.STOPPED

  function setStatus(next, info) {
    status = next
    try {
      onStatusChange?.(next, info)
    } catch (err) {
      console.error('[runner] onStatusChange 回调异常:', err)
    }
  }

  /** 计算带 bootstrap query 的 Runner URL */
  function buildUrl(bootstrap) {
    const base = runnerUrl()
    if (!bootstrap) return base
    const json = JSON.stringify(bootstrap)
    const encoded = Buffer.from(json, 'utf8').toString('base64')
    const sep = base.includes('?') ? '&' : '?'
    return `${base}${sep}bootstrap=${encoded}`
  }

  /**
   * 启动 Runner。
   * @param {{ projectId: string, projectName: string, projectRoot: string, entryScene?: string, entryScript?: string }} bootstrap
   */
  async function start(bootstrap) {
    if (!bootstrap || !bootstrap.projectId || !bootstrap.projectRoot) {
      throw new Error('[runner] start 缺少 bootstrap.projectId/projectRoot')
    }
    // 已有 Runner：先关闭（单例语义；reload 是显式调用）
    if (runnerWin) {
      await stop()
    }
    currentBootstrap = bootstrap

    setStatus(RunnerStatus.STARTING, { projectId: bootstrap.projectId })
    runnerWin = new BrowserWindow({
      width: 1280,
      height: 720,
      minWidth: 640,
      minHeight: 480,
      title: `LiteWeave Runner — ${bootstrap.projectName ?? bootstrap.projectId}`,
      backgroundColor: '#1c2127',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'runnerPreload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // Runner 是独立进程，可独立开 DevTools（dev 模式自动打开）
        // 不与 IDE 共享 session，崩溃隔离
        // backgroundThrottling:false：Runner 窗口可能被 IDE 遮挡（document.hidden=true），
        // 默认 true 会节流 rAF 导致渲染循环停摆，必须关闭
        backgroundThrottling: false,
      },
    })

    // 崩溃/意外关闭兜底
    runnerWin.on('closed', () => {
      runnerWin = null
      setStatus(RunnerStatus.STOPPED)
    })
    runnerWin.webContents.on('render-process-gone', (_e, details) => {
      console.error('[runner] 渲染进程崩溃:', details)
      setStatus(RunnerStatus.ERROR, { reason: details?.reason, exitCode: details?.exitCode })
      // 不主动销毁；让用户从 IDE 看到错误状态后决定重启
    })
    // 收集 Runner console 日志（转发到 IDE 控制台面板）
    runnerWin.webContents.on('console-message', (_e, levelOrDetails, message, line, sourceId) => {
      const levels = ['verbose', 'info', 'warning', 'error']
      let entry
      if (typeof levelOrDetails === 'object' && levelOrDetails !== null) {
        entry = {
          level: levels[levelOrDetails.level] ?? String(levelOrDetails.level),
          message: levelOrDetails.message,
          line: levelOrDetails.lineNumber,
          source: levelOrDetails.sourceUrl || levelOrDetails.source,
        }
      } else {
        entry = {
          level: levels[levelOrDetails] ?? String(levelOrDetails),
          message,
          line,
          source: sourceId,
        }
      }
      try {
        onConsole?.(entry)
      } catch (err) {
        console.error('[runner] onConsole 回调异常:', err)
      }
    })

    const url = buildUrl(bootstrap)
    if (isDev) {
      try {
        await runnerWin.loadURL(url)
      } catch (err) {
        console.error('[runner] loadURL 失败:', err)
        try { runnerWin?.destroy() } catch {}
        runnerWin = null
        throw err
      }
      // loadURL 期间窗口可能被关闭（closed 事件置 runnerWin=null），二次检查
      if (runnerWin && runnerWin.webContents) {
        runnerWin.webContents.openDevTools({ mode: 'detach' })
      }
    } else {
      await runnerWin.loadFile(url)
    }
  }

  /** 停止 Runner（关闭窗口） */
  async function stop() {
    if (!runnerWin) {
      setStatus(RunnerStatus.STOPPED)
      return
    }
    const win = runnerWin
    runnerWin = null
    // 'closed' 事件会触发 setStatus(STOPPED)；这里先标记，防止 race
    setStatus(RunnerStatus.STOPPED)
    try {
      await win.close()
    } catch (err) {
      console.error('[runner] 关闭窗口失败:', err)
      try { win.destroy() } catch {}
    }
  }

  /** 重载 Runner（保留同一窗口，重新加载页面 + 重注入 bootstrap） */
  async function reload() {
    if (!runnerWin || !currentBootstrap) {
      throw new Error('[runner] reload 时无活动 Runner')
    }
    setStatus(RunnerStatus.STARTING, { projectId: currentBootstrap.projectId })
    // 通知 Runner：即将 reload（让其重置状态）
    sendToRunner({ type: 'reload' })
    const url = buildUrl(currentBootstrap)
    if (isDev) {
      await runnerWin.loadURL(url)
    } else {
      await runnerWin.loadFile(url)
    }
    // loadURL 后 compositor 处于待激活态，requestAnimationFrame 不会被自动调度
    // （document.hidden=false + backgroundThrottling:false 都不能避免），
    // 必须主动 invalidate 触发一次重绘信号，否则渲染循环永远起不来（frameCount 卡 0）。
    runnerWin.webContents.invalidate()
  }

  /** Runner → 主进程：报告就绪 */
  function markReady() {
    setStatus(RunnerStatus.READY)
  }

  /** Runner → 主进程：上报运行状态（如渲染循环启动后 → running） */
  function reportStatus(next) {
    if (next === 'running') setStatus(RunnerStatus.RUNNING)
    else if (next === 'ready') setStatus(RunnerStatus.READY)
    else if (next === 'error') setStatus(RunnerStatus.ERROR)
    else if (next === 'stopped') setStatus(RunnerStatus.STOPPED)
    // 未知状态忽略（避免 Runner 误报导致主进程状态错乱）
  }

  /** Runner → 主进程：心跳 */
  function heartbeat(seq) {
    // 心跳不直接改 status（避免淹没状态指示器）；推送给 IDE 可选显示
    sendToIDE({ type: 'heartbeat', seq })
  }

  /** Runner → 主进程：日志转发 */
  function forwardConsole(entry) {
    try {
      onConsole?.(entry)
    } catch (err) {
      console.error('[runner] forwardConsole 异常:', err)
    }
  }

  /** IDE → Runner：发送事件（reload/stop/run 等指令） */
  function sendToRunner(event) {
    if (!runnerWin) return
    runnerWin.webContents.send('runner:event', event)
  }

  /** 主进程 → IDE：推送事件（状态变化/心跳/日志等） */
  function sendToIDE(event) {
    // 由调用方注入的 onStatusChange 之外，还需一个通用事件通道；
    // 这里通过返回值让 main.js 自行 webContents.send 到 IDE 主窗口。
    // 简化：onStatusChange 已覆盖状态变化；心跳走 console 不重复。
    // 留作扩展点（未来 IDE→Runner inspect 结果回传用）
  }

  /** IDE → Runner：执行表达式查询引擎内部状态（runner:inspect） */
  async function inspect(expression) {
    if (!runnerWin) throw new Error('[runner] inspect 时无活动 Runner')
    const result = await runnerWin.webContents.executeJavaScript(expression, true)
    return result
  }

  /** 当前状态快照（runner:status 用） */
  function getStatus() {
    return {
      status,
      projectId: currentBootstrap?.projectId ?? null,
      projectName: currentBootstrap?.projectName ?? null,
      projectRoot: currentBootstrap?.projectRoot ?? null,
      entryScene: currentBootstrap?.entryScene ?? null,
      entryScript: currentBootstrap?.entryScript ?? null,
      alive: !!runnerWin,
    }
  }

  return {
    start,
    stop,
    reload,
    markReady,
    reportStatus,
    heartbeat,
    forwardConsole,
    sendToRunner,
    inspect,
    getStatus,
    RunnerStatus,
  }
}

export { RunnerStatus }
