#!/usr/bin/env node
/**
 * purge-workspace CLI（P2-8）：删除指定 workspace 的全部 turnrewind 数据
 * （私有快照仓库 + 账本行）。引擎在 dist/index.js 构建产物中，本脚本只是
 * 薄封装——先 `pnpm --filter dsh-tauri-turnrewind build` 再运行。
 *
 * 用法：
 *   node purge-workspace.mjs <workspace-dir> [--home <dsh-home>]
 *   --home 缺省时依次读 DSH_HOME 环境变量、~/.dsh
 *
 * 运行前请先停止对应的 DSH Host 进程；workspace 被占用时本命令会拒绝执行。
 */

import process from 'node:process'
// eslint-disable-next-line antfu/no-import-dist -- 本 CLI 的引擎就在构建产物里
import { purgeWorkspace, resolveRootDir, WorkspaceLockBusyError } from './dist/index.js'

const [target, ...args] = process.argv.slice(2)
if (!target) {
  console.error('Usage: node purge-workspace.mjs <workspace-dir> [--home <dsh-home>]')
  process.exit(1)
}
// P2-8: --home 必须带一个非空参数，且不允许其他未知参数；否则 resolveRootDir
// 会回退到默认 ~/.dsh 而误删错误的数据根。
const homeArg = args.length === 0
  ? undefined
  : args.length === 2 && args[0] === '--home' && args[1] !== ''
    ? args[1]
    : undefined
if (args.length > 0 && homeArg === undefined) {
  console.error('Usage: node purge-workspace.mjs <workspace-dir> [--home <dsh-home>]')
  console.error('--home requires exactly one non-empty value and no other arguments.')
  process.exit(1)
}
const rootDir = resolveRootDir(homeArg)

try {
  const summary = purgeWorkspace(rootDir, target)
  console.warn(`rootDir:    ${summary.rootDir}`)
  console.warn(`repoDir:    ${summary.repoDir} (${summary.repoExisted ? 'removed' : 'not present'})`)
  if (summary.ledger) {
    console.warn('ledger rows removed:')
    for (const [table, count] of Object.entries(summary.ledger))
      console.warn(`  ${table}: ${count}`)
  }
}
catch (error) {
  if (error instanceof WorkspaceLockBusyError) {
    console.error(String(error))
    console.error('Stop the DSH Host process that owns this workspace, then retry.')
    process.exit(2)
  }
  throw error
}
