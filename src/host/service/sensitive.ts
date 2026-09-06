/**
 * host/service/sensitive.ts — 秘密文件快照提醒（启发式，只提醒不改变语义）。
 *
 * Git 目录模式把快照面完全委托给源仓库 ignore 规则：未写进 ignore 的
 * .env/密钥类文件会被捕获进私有快照并可被 /undo 恢复（这是有意的取舍，
 * 见 README「快照范围与敏感文件」）。本模块在会话首次追踪某工作区时做一次
 * 浅层扫描（根 + 两层，上限 500 个文件，跳过 .git/node_modules 等噪音目录），
 * 命中启发式再经 `git check-ignore --stdin` 批量过滤掉已 ignore 的文件——
 * 剩下的就是"会被快照的疑似秘密"，由调用方写成每会话/工作区一条的
 * heads-up notice。扫描/探测失败一律静默降级为"无发现"：这是提醒，不是门禁。
 */

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import process from 'node:process'
import { join } from 'pathe'
import { SYNC_GIT_TIMEOUT_MS } from '../constants'

/**
 * 基名启发式：.env*、证书/密钥扩展名、常见凭据文件名。宁可漏报不误报——
 * 提醒的措辞由调用方承担，这里只负责"看起来像秘密"。
 */
const SENSITIVE_NAME: RegExp[] = [
  /^\.env$/i,
  /^\.env\./i,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
  /^id_rsa/i,
  /^credentials/i,
  /^secrets?/i,
  /^\.npmrc$/i,
]

function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.some(re => re.test(name))
}

const MAX_SCAN_FILES = 500
const MAX_SCAN_DEPTH = 2
const SKIP_DIRS = new Set(['.git', '.turnrewind', 'node_modules'])

function collectCandidates(root: string, rel: string, depth: number, out: string[]): void {
  if (out.length >= MAX_SCAN_FILES)
    return
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true })
  }
  catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_FILES)
      return
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || depth >= MAX_SCAN_DEPTH)
        continue
      collectCandidates(root, childRel, depth + 1, out)
      continue
    }
    if (entry.isFile() && isSensitiveName(entry.name))
      out.push(childRel)
  }
}

/**
 * `git check-ignore -z --stdin` 批量过滤：返回未被 ignore 的候选。
 * git 缺失/超时/异常路径一律返回全部候选（宁可多提醒一次）。
 */
function filterIgnored(workspaceDir: string, candidates: string[]): Promise<string[]> {
  if (candidates.length === 0)
    return Promise.resolve([])
  return new Promise((resolvePromise) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', 'check-ignore', '-z', '--stdin'], {
      cwd: workspaceDir,
      env: { ...process.env },
    })
    const chunks: Buffer[] = []
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const settle = (value: string[]): void => {
      if (settled)
        return
      settled = true
      if (timeout !== undefined)
        clearTimeout(timeout)
      resolvePromise(value)
    }
    timeout = setTimeout(() => {
      child.kill('SIGKILL')
      settle(candidates)
    }, SYNC_GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stdin.on('error', () => {})
    child.on('error', () => settle(candidates))
    child.on('close', (code) => {
      // 0 = 有被 ignore 的；1 = 全部未被 ignore；两者都是有效答案。
      if (code !== 0 && code !== 1)
        return settle(candidates)
      const ignored = new Set(Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean))
      settle(candidates.filter(file => !ignored.has(file)))
    })
    child.stdin.end(candidates.join('\0'))
  })
}

/** 未被 ignore 的疑似秘密文件（工作区相对、正斜杠路径）。 */
export async function findUnignoredSensitiveFiles(workspaceDir: string): Promise<string[]> {
  const candidates: string[] = []
  collectCandidates(workspaceDir, '', 0, candidates)
  return filterIgnored(workspaceDir, candidates)
}
