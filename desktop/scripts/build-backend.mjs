/**
 * 把 server/src 打包成 ESM bundle，供 Electron 主进程内嵌加载。
 *
 * 背景：用户方向"后端在 Electron 不需要 Express"。
 * 用 esbuild 把 server/src/index.ts 的**纯逻辑服务**（createServices / JsonFileStore /
 * AiChatService，无 express 依赖）打成 desktop/dist/services.mjs。
 * 主进程直接 new/调用服务，IPC 按 endpoint 路由，不走 HTTP 端口。
 *
 * Express 壳（startBackend）仅供独立 Web 模式使用，不进 Electron bundle。
 * 但 esbuild 会整体打包 index.ts 入口（含 express import）——因此这里用
 * 单独入口文件 services-entry.ts 只导出纯逻辑，避免把 express 拖进来。
 *
 * 用法：npm run build:backend -w desktop
 */
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..') // LiteWeave 根
const outDir = resolve(__dirname, '../dist')
const servicesOut = resolve(outDir, 'services.mjs')
const scriptHostOut = resolve(outDir, 'scriptHost.mjs')

await mkdir(outDir, { recursive: true })
// 只删各自输出文件（不删整个 dist，避免互相覆盖）
await rm(servicesOut, { force: true })
await rm(`${servicesOut}.map`, { force: true })
await rm(scriptHostOut, { force: true })
await rm(`${scriptHostOut}.map`, { force: true })

// services.mjs：第三方依赖 external（express 等运行时从 node_modules 解析）
await build({
  entryPoints: [resolve(root, 'server/src/servicesEntry.ts')],
  outfile: servicesOut,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
})
console.log(`[build-backend] services → ${servicesOut}`)

// scriptHost.mjs：把 @liteweave/engine 源码 + gl-matrix 打进 bundle
// （engine 是 TS 源码无预编译产物，主进程不能直接 import TS；gl-matrix 纯 JS 可打进）
await build({
  entryPoints: [resolve(__dirname, '../src/scriptHost.ts')],
  outfile: scriptHostOut,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // gl-matrix 打进 bundle（纯 JS，体积小）；engine 源码也打进
  packages: 'bundle',
  sourcemap: true,
  logLevel: 'info',
  alias: {
    '@liteweave/engine': resolve(root, 'engine/src/index.ts'),
  },
})
console.log(`[build-backend] scriptHost → ${scriptHostOut}`)

console.log('[build-backend] done')

