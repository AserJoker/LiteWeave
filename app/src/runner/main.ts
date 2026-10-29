/**
 * LiteWeave Runner —— 空页面占位。
 *
 * engine 模块已清空，从头设计中。当前 Runner 只保留窗口骨架 + bootstrap 显示，
 * 不做任何 WebGPU 渲染 / 脚本消费。新的 engine 设计落地后在此重新接入。
 */
import './runner.css'

/** Runner preload 暴露的桥（与 desktop/src/runnerPreload.cjs 契约一致） */
interface RunnerBridge {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>
  onEvent(cb: (event: { type: string; payload?: unknown }) => void): () => void
  getBootstrap(): {
    projectRoot: string
    projectId: string
    projectName: string
    entryScene?: string
    entryScript?: string
  } | null
}

function getBridge(): RunnerBridge | undefined {
  const w = window as unknown as { liteweaveRunner?: RunnerBridge }
  return w.liteweaveRunner
}

const root = document.getElementById('runner-root')!

root.innerHTML = `
  <div class="lwrunner-empty">
    <h1>LiteWeave Runner</h1>
    <p class="lwrunner-muted">engine 重新设计中，Runner 暂为空页面。</p>
    <div id="lwrunner-bootstrap" class="lwrunner-bootstrap"></div>
  </div>
`

const bootstrapNode = document.getElementById('lwrunner-bootstrap')!

const bridge = getBridge()
if (!bridge) {
  bootstrapNode.innerHTML = `<p class="lwrunner-error">window.liteweaveRunner 不可用（preload 未注入）</p>`
} else {
  const bootstrap = bridge.getBootstrap()
  if (bootstrap) {
    bootstrapNode.innerHTML = `
      <div class="lwrunner-row"><span class="lwrunner-label">项目</span><span class="lwrunner-value">${escapeHtml(bootstrap.projectName)} <code>${escapeHtml(bootstrap.projectId)}</code></span></div>
      <div class="lwrunner-row"><span class="lwrunner-label">根目录</span><span class="lwrunner-value"><code>${escapeHtml(bootstrap.projectRoot)}</code></span></div>
      <div class="lwrunner-row"><span class="lwrunner-label">入口场景</span><span class="lwrunner-value">${escapeHtml(bootstrap.entryScene ?? '—')}</span></div>
      <div class="lwrunner-row"><span class="lwrunner-label">入口脚本</span><span class="lwrunner-value">${escapeHtml(bootstrap.entryScript ?? '—')}</span></div>
    `
  } else {
    bootstrapNode.innerHTML = `<p class="lwrunner-muted">主进程未注入 bootstrap 信息</p>`
  }

  // 通知主进程：Runner 页面已就绪
  void bridge.invoke('runner:ready', { at: new Date().toISOString() }).catch((err) => {
    console.error('[runner] runner:ready 失败:', err)
  })

  // 占位：保留事件订阅骨架，engine 重新接入后在此处理 scene-ready / tick-delta 等
  bridge.onEvent((_event) => {
    // no-op
  })
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c] as string))
}
