/**
 * Electron preload —— 通过 contextBridge 把安全能力暴露给渲染进程。
 *
 * 注意：preload 必须用 CommonJS 语法（sandbox 模式下 ESM 不受支持），
 * 因此这里用 require / module.exports，而不是 import/export。
 *
 * 渲染进程通过 window.liteweave 访问（传输层适配器 ElectronAdapter 消费）：
 * - request(method, path, body?)：REST 语义请求（endpoint + JSON）→ IPC → 主进程路由到服务
 * - subscribe(path, cb)：订阅服务端推送（替代 SSE）→ 返回 { id, unsubscribe }
 * - invoke(channel, payload?)：命令式调用（原生能力：打开项目 / 读目录等）
 *
 * 协议统一 endpoint+JSON：未来 Web 移植时 request→fetch / subscribe→EventSource，
 * 业务层不感知传输差异（见 app/src/core/transport/）。
 */
const { contextBridge, ipcRenderer } = require('electron')

/** 订阅注册表：订阅 id → 回调（收到主进程推送时调用） */
const subCallbacks = new Map()

contextBridge.exposeInMainWorld('liteweave', {
  /** REST 语义请求：request('GET', '/api/settings') → 主进程服务层处理，返回 JSON */
  request: (method, path, body) => ipcRenderer.invoke('transport:request', { method, path, body }),

  /**
   * 订阅服务端推送（替代 SSE）。返回 { id, unsubscribe }。
   * 回调收到主进程推送的变更数据（如 settings 域 {key, value}）。
   */
  subscribe: (path, cb) => {
    const subId = ipcRenderer.sendSync('transport:subscribe', path)
    subCallbacks.set(subId, cb)
    return {
      id: subId,
      unsubscribe: () => {
        subCallbacks.delete(subId)
        ipcRenderer.send('transport:unsubscribe', subId)
      },
    }
  },

  /** 命令式调用（原生能力）：invoke('project:readDir', dirPath) 等 */
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),

  /**
   * 订阅主进程推送的 MCP 命令（agent 经 MCP 触发 → 主进程 → 渲染进程执行）。
   * 回调收到 { command, args }；返回取消订阅函数。
   */
  onMcpCommand: (cb) => {
    const listener = (_event, payload) => {
      try {
        cb(payload)
      } catch (err) {
        console.error('[preload] MCP 命令回调异常:', err)
      }
    }
    ipcRenderer.on('mcp:command', listener)
    return () => ipcRenderer.removeListener('mcp:command', listener)
  },

  /**
   * 订阅主进程推送的 Runner 事件（状态变化 / console 日志 / 心跳）。
   * Runner 是独立进程，IDE 经主进程中转获取 Runner 状态：
   *   Runner ──ipc──► 主进程 ──webContents.send('runner:event')──► IDE（本回调）
   * 回调收到 { type, status?, info?, entry?, at? }；返回取消订阅函数。
   */
  onRunnerEvent: (cb) => {
    const listener = (_event, payload) => {
      try {
        cb(payload)
      } catch (err) {
        console.error('[preload] Runner 事件回调异常:', err)
      }
    }
    ipcRenderer.on('runner:event', listener)
    return () => ipcRenderer.removeListener('runner:event', listener)
  },
})

// 主进程推送 → 分发到对应订阅回调（transport:event 事件）
ipcRenderer.on('transport:event', (_event, payload) => {
  const { subId, data } = payload ?? {}
  const cb = subCallbacks.get(subId)
  if (cb) {
    try {
      cb(data)
    } catch (err) {
      console.error('[preload] 订阅回调异常:', err)
    }
  }
})
