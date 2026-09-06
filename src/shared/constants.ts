/**
 * shared/constants.ts — 跨 host/client 的稳定协议常量。
 *
 * API 前缀与插件名是两半端共享的线协议面：host 路由注册、client RPC 各自硬编码
 * 会漂移，集中在此由两端共同引用。
 */

/** 插件名（诊断元数据 / registrant / storage key 前缀）。 */
export const TURNREWIND_PLUGIN_NAME = 'dsh-tauri-turnrewind'

/** HTTP 路由前缀（host route + client rpc 同源 fetch）。 */
export const TURNREWIND_API_PREFIX = '/api/turnrewind'

/** 弹窗去重的 localStorage 基名（不带冒号，driver 侧拼前缀）。 */
export const TURNREWIND_STORAGE_BASE = 'dsh-tauri-turnrewind'
