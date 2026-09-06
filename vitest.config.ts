import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// dsh-tauri/client 指向本地垫片（npm 0.6.7 的 client.cjs 是浏览器脚本，
// Node 下不可 import；桌面运行时使用注入的真实模块，垫片不参与构建产物）。
const dshClientShim = fileURLToPath(new URL('./compat/dsh-tauri-client.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'dsh-tauri/client': dshClientShim,
    },
  },
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 120000,
  },
})
