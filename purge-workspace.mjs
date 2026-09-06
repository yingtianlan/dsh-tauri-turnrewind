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
import { purgeWorkspace, resolveRootDir, WorkspaceLockBusyError } from './dist/index.js'

const [target, ...args] = process.argv.slice(2)
if (!target) {
  console.error('Usage: node purge-workspace.mjs <workspace-dir> [--home <dsh-home>]')
  process.exit(1)
}
const homeIndex = args.indexOf('--home')
const rootDir = resolveRootDir(homeIndex !== -1 ? args[homeIndex + 1] : undefined)

try {
  const summary = purgeWorkspace(rootDir, target)
  console.log(`rootDir:    ${summary.rootDir}`)
  console.log(`repoDir:    ${summary.repoDir} (${summary.repoExisted ? 'removed' : 'not present'})`)
  if (summary.ledger) {
    console.log('ledger rows removed:')
    for (const [table, count] of Object.entries(summary.ledger))
      console.log(`  ${table}: ${count}`)
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
