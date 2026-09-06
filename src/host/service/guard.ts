/**
 * host/service/guard.ts — 系统目录工作区拒绝（家目录/祖先/盘根）。
 *
 * Git 目录模式不再做全目录预算扫描：Git ignore 语义决定快照面，本守卫只保留
 * 「绝不可快照」的系统目录判定。pathe 输出正斜杠而宿主 cwd 可能带反斜杠，
 * 比较前统一归一化分隔符；pathe 对「已绝对的盘根」（resolve('C:/') → '/C:'）
 * 有怪输出，normalize 前先把裸盘符恢复成盘根形态。
 */

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'
import { parse, resolve } from 'pathe'

const BACKSLASH = String.fromCharCode(92)

function normalizeDir(path: string): string {
  const raw = resolve(path)
  // pathe resolve('C:/') 产 '/C:'（丢失盘根语义）；恢复为 'C:/'。
  const corrected = process.platform === 'win32' && /^\/[a-z]:$/i.test(raw)
    ? `${raw.slice(1)}/`
    : raw
  try {
    // realpathSync 需要平台分隔符（盘根 'C:' 会拼错路径）。
    const fsPath = process.platform === 'win32'
      ? corrected.replaceAll('/', BACKSLASH)
      : corrected
    return realpathSync(fsPath)
  }
  catch {
    // Missing or unreadable paths still need a deterministic comparison key.
    return corrected
  }
}

function foldCase(path: string): string {
  const folded = process.platform === 'win32' ? path.toLowerCase() : path
  return folded.replaceAll(BACKSLASH, '/')
}

export function isSystemSensitiveWorkspace(workspaceDir: string): boolean {
  const workspace = foldCase(normalizeDir(workspaceDir))
  // P2-11: UNC 共享（//server/share/...）——分享根（仅 server/share 两段）
  // 是一整台机器的导出面，快照范围不可控，直接拒绝；更深的子目录允许。
  if (workspace.startsWith('//')) {
    const segments = workspace.split('/').filter(Boolean)
    if (segments.length <= 2)
      return true
  }
  const home = foldCase(normalizeDir(homedir()))
  if (workspace === home)
    return true
  // An ancestor of the home directory would snapshot every user profile
  // including the DSH data dir itself, so refuse it alongside the home dir.
  if (home.startsWith(`${workspace}/`))
    return true
  const root = foldCase(parse(workspace).root)
  return root === workspace
}
