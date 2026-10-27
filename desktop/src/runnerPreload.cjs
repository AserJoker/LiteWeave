/**
 * Runner preload —— Runner 窗口的 contextBridge 桥。
 *
 * 与 IDE 主窗口的 preload.cjs 隔离：
 * - 主窗口暴露 window.liteweave（IDE 编辑器能力：transport / mcp 命令订阅）
 * - Runner 暴露 window.liteweaveRunner（Runner 能力：runner:* IPC + 事件订阅 + bootstrap）
 *
 * Runner 不需要 transport（不连服务层）、不需要 MCP 命令订阅（不被 AI 直接操作 UI）；
 * 它的职责是承载引擎业务层主循环，与主进程双向通讯：
 * - invoke(channel, payload)：调主进程 runner:* IPC（runner:ready / runner:heartbeat / runner:console）
 * - onEvent(cb)：订阅主进程推送的 runner 事件（IDE 经主进程转发的 reload/stop/run 等指令）
 * - getBootstrap()：同步取主进程在创建窗口时注入的项目/入口信息（query 参数）
 */
const { contextBridge, ipcRenderer } = require('electron')

/** 主进程推送事件回调表（runner:event 统一通道，按 type 区分） */
let eventCb = null

contextBridge.exposeInMainWorld('liteweaveRunner', {
  /** 命令式调用主进程 runner IPC */
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),

  /**
   * 订阅主进程推送的 runner 事件（IDE→Runner 指令转发等）。
   * 回调收到 { type, payload? }；返回取消订阅函数。
   */
  onEvent: (cb) => {
    eventCb = cb
    const listener = (_event, payload) => {
      try {
        cb(payload)
      } catch (err) {
        console.error('[runner-preload] 事件回调异常:', err)
      }
    }
    ipcRenderer.on('runner:event', listener)
    return () => {
      if (eventCb === cb) eventCb = null
      ipcRenderer.removeListener('runner:event', listener)
    }
  },

  /**
   * 同步获取启动时主进程注入的项目/入口信息。
   * 主进程在创建 Runner 窗口时把 bootstrap 数据序列化到 URL query（?bootstrap=<base64-json>），
   * preload 在加载前同步解析（避免异步 race，Runner 主脚本一启动就能拿到）。
   */
  getBootstrap: () => {
    try {
      const url = new URL(window.location.href)
      const encoded = url.searchParams.get('bootstrap')
      if (!encoded) return null
      const json = Buffer.from(encoded, 'base64').toString('utf8')
      return JSON.parse(json)
    } catch (err) {
      console.error('[runner-preload] 解析 bootstrap 失败:', err)
      return null
    }
  },
})
