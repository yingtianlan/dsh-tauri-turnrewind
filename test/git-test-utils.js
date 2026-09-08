import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'pathe'

/**
 * macOS 上 /var → /private/var 的 symlink 导致 mkdtemp 返回的路径与
 * git --show-toplevel 返回的路径不同；Windows CI 上 TEMP 还可能是 8.3 短名
 * （C:\Users\RUNNER~1\...）而 git 返回磁盘长名。测试比较路径时统一走
 * realpathSync.native + pathe resolve 归一化——`.native` 会把 8.3 短名展开为
 * 长名（plain realpathSync 不会），与生产侧 safeRealpath/workspaceKey 一致。
 */
export function resolvedRealPath(p) {
  return resolve(realpathSync.native(p))
}

export function runGit(cwd, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd })
    const errors = []
    child.stderr.on('data', chunk => errors.push(chunk))
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`git ${args.join(' ')} failed: ${Buffer.concat(errors).toString('utf8').trim()}`))
        return
      }
      resolvePromise()
    })
  })
}

export function gitOutput(cwd, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd })
    const chunks = []
    const errors = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => errors.push(chunk))
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`git ${args.join(' ')} failed: ${Buffer.concat(errors).toString('utf8').trim()}`))
        return
      }
      resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

export async function commitAll(workspace, message) {
  await runGit(workspace, ['add', '--all'])
  await runGit(workspace, ['commit', '--quiet', '-m', message])
}

export async function initGitWorkspace(workspace) {
  await mkdir(workspace, { recursive: true })
  await runGit(workspace, ['init', '--quiet'])
  await runGit(workspace, ['config', 'user.name', 'Turn Rewind Test'])
  await runGit(workspace, ['config', 'user.email', 'turnrewind-test@localhost'])
  // Pin line-ending behavior so fixtures are deterministic on machines whose
  // Git for Windows system config sets core.autocrlf=true: checkout and add
  // then write and hash the exact bytes the test wrote.
  await runGit(workspace, ['config', 'core.autocrlf', 'false'])
  return workspace
}
