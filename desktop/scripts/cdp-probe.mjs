// CDP 主世界探针：连到 Electron 渲染进程，验证 window.liteweave 桥 + 调项目管理 IPC
// 用法：node scripts/cdp-probe.mjs [channel] [jsonPayload]
const targetUrl = 'http://127.0.0.1:9222/json/list'
const list = await fetch(targetUrl).then((r) => r.json())
const page = list.find((t) => t.type === 'page' && t.url.includes('localhost:5173'))
if (!page) {
  console.log('no electron page target')
  process.exit(1)
}
// Node 22+ 原生 WebSocket（无依赖）
const sock = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
function send(method, params) {
  return new Promise((resolve) => {
    const i = ++id
    pend.set(i, resolve)
    sock.send(JSON.stringify({ id: i, method, params }))
  })
}
await new Promise((r) => sock.addEventListener('open', r))
sock.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data.toString())
  if (msg.id && pend.has(msg.id)) {
    pend.get(msg.id)(msg)
    pend.delete(msg.id)
  }
})

const bridgeExpr = "({hasBridge:typeof window.liteweave!=='undefined', keys: typeof window.liteweave!=='undefined'?Object.keys(window.liteweave):[]})"
const r1 = await send('Runtime.evaluate', { expression: bridgeExpr, returnByValue: true })
console.log('bridge:', JSON.stringify(r1.result.result.value))

if (process.argv[2] === '__dom__' || process.argv[2] === '__await__') {
  const expr = process.argv[3] ?? 'document.body.innerText.slice(0,800)'
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: process.argv[2] === '__await__',
  })
  console.log('DOM ->', JSON.stringify(r.result.result.value))
  sock.close()
  process.exit(0)
}

if (process.argv[2] === '__console__') {
  // 订阅 console 事件，等 1.5s 收集（需先刷新页面才看得到历史，这里仅采集新产生的）
  const collected = []
  sock.addEventListener('message', (event) => {
    const m = JSON.parse(event.data)
    if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '')
      collected.push(`[${m.params.type}] ` + args.join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      collected.push('[exception] ' + (d.exception?.description ?? d.text))
    }
  })
  await send('Runtime.enable', {})
  await new Promise((r) => setTimeout(r, 1500))
  console.log('console ->', JSON.stringify(collected, null, 2))
  sock.close()
  process.exit(0)
}

const channel = process.argv[2] ?? 'project:list'
const payload = process.argv[3]
const callExpr = `window.liteweave.invoke(${JSON.stringify(channel)}${payload ? ',' + JSON.stringify(JSON.parse(payload)) : ''}).then(x=>JSON.stringify(x)).catch(e=>'ERR:'+e.message)`
const r2 = await send('Runtime.evaluate', { expression: callExpr, awaitPromise: true, returnByValue: true })
console.log(`${channel} ->`, r2.result.result.value)

sock.close()
process.exit(0)
