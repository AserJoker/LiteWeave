import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
//
// 多入口：
// - index.html：IDE 主窗口（编辑器 + 静态预览）
// - runner.html：Runner 窗口（引擎业务层承载，独立 Electron 进程）
//
// 开发模式两个入口都走 Vite dev server，主进程按 URL 选择加载哪个页面；
// 生产模式 build 出两套 HTML 产物，主进程按文件路径加载。
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        runner: 'runner.html',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 开发环境把 /api 请求代理到后端 server (port 3001)
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
