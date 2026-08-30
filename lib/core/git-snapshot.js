import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { TextDecoder, TextEncoder } from 'node:util'

const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

// Only high-confidence sensitive names are excluded: substring rules like
// *token* silently dropped legitimate source files (token.ts and friends) from
// snapshots, so undo could never restore them — not even the dry-run showed
// them, because excluded paths never enter the before/after diff.
const EXCLUDE_PATHS = [
  ':(exclude,glob).git/**',
  ':(exclude,glob)**/.git/**',
  ':(exclude,glob)node_modules/**',
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)dist/**',
  ':(exclude,glob)**/dist/**',
  ':(exclude,glob)build/**',
  ':(exclude,glob)**/build/**',
  ':(exclude,glob)coverage/**',
  ':(exclude,glob)**/coverage/**',
  ':(exclude,glob).turnrewind/**',
  ':(exclude,glob)**/.turnrewind/**',
  ':(exclude,glob).env',
  ':(exclude,glob)**/.env',
  ':(exclude,glob).env.*',
  ':(exclude,glob)**/.env.*',
  ':(exclude,glob)**/*.pem',
  ':(exclude,glob)**/*.key',
  ':(exclude,glob)id_rsa*',
  ':(exclude,glob)**/id_rsa*',
  ':(exclude,glob)credentials.*',
  ':(exclude,glob)secrets.*',
]

/**
 * Run one git command without blocking the host event loop. All snapshot I/O
 * used to be synchronous, which froze the whole host — every session, the web
 * UI and the health check — for the duration of `git add` on big workspaces.
 */
function runGit(repoDir, workspaceDir, args, extraEnv = {}, maxBytes = MAX_OUTPUT_BYTES) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '--git-dir', repoDir, '--work-tree', workspaceDir, ...args], {
      cwd: workspaceDir,
      env: { ...process.env, ...extraEnv },
    })
    const chunks = []
    const errors = []
    let total = 0
    let settled = false

    const fail = (error) => {
      if (settled)
        return
      settled = true
      child.kill()
      rejectPromise(error)
    }
    child.stdout.on('data', (chunk) => {
      if (settled)
        return
      total += chunk.length
      if (total > maxBytes) {
        fail(new Error(`TURNREWIND_OUTPUT_TOO_LARGE: git output exceeded ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (!settled)
        errors.push(chunk)
    })
    child.on('error', error => fail(new Error(`TURNREWIND_GIT_EXEC: ${error.message}`)))
    child.on('close', (code) => {
      if (settled)
        return
      settled = true
      const stdout = Buffer.concat(chunks)
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString('utf8').trim() || stdout.toString('utf8').trim() || `exit ${code}`
        rejectPromise(new Error(`TURNREWIND_GIT_FAILED: ${detail}`))
        return
      }
      resolvePromise(stdout)
    })
  })
}

async function runGitText(repoDir, workspaceDir, args, extraEnv = {}) {
  const output = await runGit(repoDir, workspaceDir, args, extraEnv)
  return output.toString('utf8')
}

let gitProbeResult

/** Resolve once per host process: whether a git executable is usable at all. */
export function gitAvailable() {
  gitProbeResult ??= new Promise((resolvePromise) => {
    const child = spawn('git', ['--version'])
    let settled = false
    const settle = value => (settled ? undefined : (settled = true, resolvePromise(value)))
    child.on('error', () => settle(false))
    child.on('close', code => settle(code === 0))
  })
  return gitProbeResult
}

async function ensureRepository(repoDir, workspaceDir) {
  if (!existsSync(join(repoDir, 'HEAD'))) {
    mkdirSync(dirname(repoDir), { recursive: true })
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('git', ['init', '--bare', repoDir])
      const errors = []
      child.stderr.on('data', chunk => errors.push(chunk))
      child.on('error', error => rejectPromise(new Error(`TURNREWIND_GIT_INIT: ${error.message}`)))
      child.on('close', (code) => {
        if (code !== 0)
          rejectPromise(new Error(`TURNREWIND_GIT_INIT: ${Buffer.concat(errors).toString('utf8').trim() || 'git init failed'}`))
        else
          resolvePromise()
      })
    })
  }
  await runGitText(repoDir, workspaceDir, ['config', 'core.bare', 'false'])
  await runGitText(repoDir, workspaceDir, ['config', 'core.worktree', workspaceDir])
}

async function gitRef(repoDir, workspaceDir, ref) {
  try {
    const output = await runGitText(repoDir, workspaceDir, ['rev-parse', '--verify', ref])
    return output.trim()
  }
  catch {
    return undefined
  }
}

function assertSafePath(workspaceDir, path) {
  const root = resolve(workspaceDir)
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`TURNREWIND_PATH_ESCAPE: ${path}`)
  }

  let current = root
  const suffix = relative(root, target)
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`TURNREWIND_SYMLINK_UNSUPPORTED: ${path}`)
    }
  }
  return target
}

function snapshotPathspecs() {
  return EXCLUDE_PATHS
}

export function workspaceHash(workspaceDir) {
  const normalized = resolve(workspaceDir)
  const identity = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  return createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

/** Pure path computation; the repository itself is ensured lazily on capture. */
export function createSnapshotStore(rootDir, workspaceDir) {
  const normalizedWorkspace = resolve(workspaceDir)
  const repoDir = join(rootDir, 'snapshots', `${workspaceHash(normalizedWorkspace)}.git`)
  return { repoDir, workspaceDir: normalizedWorkspace }
}

// Directories the snapshot walk must not descend into (mirrors EXCLUDE_PATHS).
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.turnrewind'])

function isExcludedPath(relPath, isDir) {
  const base = basename(relPath)
  if (isDir)
    return EXCLUDE_DIRS.has(base)
  // Files excluded by EXCLUDE_PATHS: .env, .env.*, *.pem, *.key, id_rsa*,
  // credentials.*, secrets.*
  if (/^\.env(?:$|\.)/.test(base))
    return true
  if (/\.(?:pem|key)$/i.test(base))
    return true
  if (base.startsWith('id_rsa') || /^credentials\./.test(base) || /^secrets\./.test(base))
    return true
  return false
}

/**
 * Pre-flight estimate of what a snapshot would track, WITHOUT creating a git repo.
 * Walks the workspace (accepting the same excluded paths as the real snapshot),
 * counting files, total bytes, largest file, and directory nesting depth. It
 * stops as soon as any configured limit is hit, so a huge directory does not
 * get fully walked. Callers should skip snapshot tracking (and undo) entirely
 * when this returns ok=false, so the plugin never bloats its private repo with a
 * big or deeply nested workspace.
 *
 * @param workspaceDir - root directory to estimate.
 * @param limits       - optional overrides: maxFileCount, maxTotalBytes,
 *                       maxFileBytes, maxDepth, maxDirs.
 * @returns { ok: true, fileCount, totalBytes, maxFileBytes, maxDepth, dirCount }
 *   or { ok: false, reason }.
 */
export function probeWorkspace(workspaceDir, limits = {}) {
  const maxFileCount = limits.maxFileCount ?? 10000
  const maxTotalBytes = limits.maxTotalBytes ?? 512 * 1024 * 1024
  const maxFileBytes = limits.maxFileBytes ?? 50 * 1024 * 1024
  const maxDepth = limits.maxDepth ?? 20
  const maxDirs = limits.maxDirs ?? 10000
  const root = resolve(workspaceDir)
  let fileCount = 0
  let totalBytes = 0
  let largestFile = 0
  let dirCount = 0
  let deepest = 0
  // Iterative DFS (explicit stack) so deep nesting cannot blow the call stack.
  const stack = [{ absolute: root, depth: 0 }]
  while (stack.length > 0) {
    const { absolute, depth } = stack.pop()
    if (depth > maxDepth)
      return { ok: false, reason: `nesting depth ${depth} exceeds limit (${maxDepth})` }
    deepest = Math.max(deepest, depth)
    let entries
    try {
      entries = readdirSync(absolute, { withFileTypes: true })
    }
    catch {
      continue
    }
    for (const entry of entries) {
      const full = join(absolute, entry.name)
      const rel = relative(root, full)
      if (isExcludedPath(rel, entry.isDirectory()))
        continue
      if (entry.isDirectory()) {
        dirCount += 1
        if (dirCount > maxDirs)
          return { ok: false, reason: `directory count ${dirCount} exceeds limit (${maxDirs})` }
        stack.push({ absolute: full, depth: depth + 1 })
      }
      else if (entry.isFile()) {
        let size
        try {
          size = statSync(full).size
        }
        catch {
          continue
        }
        fileCount += 1
        totalBytes += size
        if (size > largestFile)
          largestFile = size
        if (fileCount > maxFileCount)
          return { ok: false, reason: `file count ${fileCount} exceeds limit (${maxFileCount})` }
        if (size > maxFileBytes)
          return { ok: false, reason: `file ${rel} is ${size} bytes, larger than limit (${maxFileBytes})` }
        if (totalBytes > maxTotalBytes)
          return { ok: false, reason: `total size ${totalBytes} bytes exceeds limit (${maxTotalBytes})` }
      }
    }
  }
  return { ok: true, fileCount, totalBytes, maxFileBytes: largestFile, maxDepth: deepest, dirCount }
}

/**
 * Capture a complete allowed-path tree, incrementally reusing the parent tree.
 * A missing parent (wiped snapshot directory, moved DSH_HOME) degrades to a
 * fresh baseline instead of failing every future turn.
 */
export async function captureSnapshot(store, refName, message, parentRef) {
  const { repoDir, workspaceDir } = store
  await ensureRepository(repoDir, workspaceDir)
  let parent
  if (parentRef) {
    parent = await gitRef(repoDir, workspaceDir, parentRef)
    if (!parent)
      console.warn(`turnrewind: snapshot parent ${parentRef} is gone; building a fresh baseline for ${workspaceDir}`)
  }
  const indexPath = join(repoDir, `turnrewind-index-${randomUUID()}`)
  try {
    const env = { GIT_INDEX_FILE: indexPath }
    if (parent)
      await runGit(repoDir, workspaceDir, ['read-tree', parent], env)
    await runGit(repoDir, workspaceDir, ['add', '--all', '--', '.', ...snapshotPathspecs()], env)
    const tree = (await runGit(repoDir, workspaceDir, ['write-tree'], env)).toString('utf8').trim()
    const identity = {
      GIT_AUTHOR_NAME: 'DSH Turn Rewind',
      GIT_AUTHOR_EMAIL: 'turnrewind@localhost',
      GIT_COMMITTER_NAME: 'DSH Turn Rewind',
      GIT_COMMITTER_EMAIL: 'turnrewind@localhost',
    }
    const args = ['commit-tree', tree, '-m', message]
    if (parent)
      args.push('-p', parent)
    const commit = (await runGit(repoDir, workspaceDir, args, { ...env, ...identity })).toString('utf8').trim()
    await runGit(repoDir, workspaceDir, ['update-ref', refName, commit])
    return { commit, refName }
  }
  finally {
    rmSync(indexPath, { force: true })
  }
}

export async function snapshotDiff(store, beforeCommit, afterCommit) {
  const output = await runGit(store.repoDir, store.workspaceDir, ['diff', '--name-only', '--no-renames', beforeCommit, afterCommit])
  return [...new Set(output.toString('utf8').split(/\r?\n/).map(value => value.trim()).filter(Boolean))]
}

const DEFAULT_MAX_DIFF_LINES = 120

function truncateDiff(text, maxLines = DEFAULT_MAX_DIFF_LINES) {
  const lines = text.replace(/\n$/u, '').split('\n')
  if (lines.length <= maxLines || lines[0] === '')
    return lines[0] === '' ? '' : lines.join('\n')
  return `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more line(s) truncated)`
}

/** Run one git command with data piped to stdin (e.g. hash-object -w --stdin). */
function runGitStdin(repoDir, workspaceDir, args, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '--git-dir', repoDir, '--work-tree', workspaceDir, ...args], {
      cwd: workspaceDir,
      env: { ...process.env },
    })
    const chunks = []
    const errors = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => errors.push(chunk))
    child.on('error', error => rejectPromise(new Error(`TURNREWIND_GIT_EXEC: ${error.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`TURNREWIND_GIT_FAILED: ${Buffer.concat(errors).toString('utf8').trim() || `exit ${code}`}`))
        return
      }
      resolvePromise(Buffer.concat(chunks))
    })
    // Ignore EPIPE if git exits before consuming all input.
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/** Classify how one path changed between two snapshots: created, deleted, or modified. */
export async function classifyPathChange(store, beforeCommit, afterCommit, path) {
  const before = await stateAt(store, beforeCommit, path)
  const after = await stateAt(store, afterCommit, path)
  if (before.kind === 'absent' && after.kind === 'file')
    return 'created'
  if (before.kind === 'file' && after.kind === 'absent')
    return 'deleted'
  return 'modified'
}

/** Unified diff of one path between two snapshot commits, truncated to maxLines. */
export async function snapshotFileDiff(store, fromCommit, toCommit, path, maxLines) {
  const output = await runGit(store.repoDir, store.workspaceDir, ['diff', '--no-renames', fromCommit, toCommit, '--', path])
  return truncateDiff(output.toString('utf8'), maxLines)
}

// The well-known empty blob is not pre-populated in a fresh private repo, so
// write it on first use (its hash is always e69de29bb2d1d6434b8b29ae775ad8c2e48c5391).
async function ensureEmptyBlob(store) {
  if (!store.emptyBlob) {
    const output = await runGitStdin(store.repoDir, store.workspaceDir, ['hash-object', '-w', '--stdin'], '')
    store.emptyBlob = output.toString('utf8').trim()
  }
  return store.emptyBlob
}

async function blobFor(store, commit, path) {
  if (!await commitEntry(store, commit, path))
    return ensureEmptyBlob(store)
  const output = await runGit(store.repoDir, store.workspaceDir, ['rev-parse', `${commit}:${path}`])
  return output.toString('utf8').trim()
}

async function hashDiskFile(store, workspaceDir, path) {
  const target = assertSafePath(workspaceDir, path)
  if (!existsSync(target))
    return ensureEmptyBlob(store)
  const info = lstatSync(target)
  if (!info.isFile() || info.size > MAX_FILE_BYTES)
    return undefined
  const output = await runGitStdin(store.repoDir, store.workspaceDir, ['hash-object', '-w', '--stdin'], readFileSync(target))
  return output.toString('utf8').trim()
}

/**
 * Unified diff between a path's committed state and its current on-disk content.
 * Used to show what a human (or another session) changed after a turn, i.e. the
 * content an undo would overwrite. The disk content is hashed into the private
 * snapshot repo; the user's own repository is never touched.
 */
export async function diffAgainstDisk(store, commit, path, maxLines) {
  const from = await blobFor(store, commit, path)
  const to = await hashDiskFile(store, store.workspaceDir, path)
  if (to === undefined)
    return '(current file is not a regular file or exceeds the size limit)'
  if (from === to)
    return ''
  const output = await runGit(store.repoDir, store.workspaceDir, [
    'diff',
    '--no-renames',
    '--src-prefix=snapshot/',
    '--dst-prefix=disk/',
    from,
    to,
  ])
  return truncateDiff(output.toString('utf8'), maxLines)
}

async function commitEntry(store, commit, path) {
  const output = await runGit(store.repoDir, store.workspaceDir, ['ls-tree', '-r', '--name-only', commit, '--', path])
  return output.toString('utf8').split(/\r?\n/).includes(path)
}

async function commitBytes(store, commit, path) {
  const output = await runGit(store.repoDir, store.workspaceDir, ['show', `${commit}:${path}`], {}, MAX_FILE_BYTES + 1)
  if (output.length > MAX_FILE_BYTES)
    throw new Error(`TURNREWIND_FILE_TOO_LARGE: ${path}`)
  return output
}

function digest(bytes) {
  let comparable = bytes
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    comparable = new TextEncoder().encode(text.replaceAll('\r\n', '\n'))
  }
  catch {
    // Binary data has no newline normalization; compare its exact bytes.
  }
  return createHash('sha256').update(comparable).digest('hex')
}

export async function stateAt(store, commit, path) {
  // stateAt only inspects the private snapshot repo (commit:path revisions),
  // never the filesystem, so a symlinked or odd path simply reads as absent.
  if (!await commitEntry(store, commit, path))
    return { kind: 'absent', digest: null }
  const bytes = await commitBytes(store, commit, path)
  return { kind: 'file', digest: digest(bytes) }
}

export function currentState(workspaceDir, path) {
  const target = assertSafePath(workspaceDir, path)
  if (!existsSync(target))
    return { kind: 'absent', digest: null }
  const info = lstatSync(target)
  if (!info.isFile() || info.size > MAX_FILE_BYTES)
    return { kind: 'unsupported', digest: null }
  return { kind: 'file', digest: digest(readFileSync(target)) }
}

export async function restorePath(store, commit, path) {
  const target = assertSafePath(store.workspaceDir, path)
  if (!await commitEntry(store, commit, path)) {
    if (existsSync(target)) {
      const info = lstatSync(target)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path}`)
      rmSync(target, { recursive: info.isDirectory(), force: true })
    }
    return { path, result: 'removed' }
  }

  const bytes = await commitBytes(store, commit, path)
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.turnrewind-${randomUUID()}.tmp`
  writeFileSync(temp, bytes, { flag: 'wx' })
  try {
    if (existsSync(target)) {
      const info = lstatSync(target)
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path}`)
      rmSync(target, { force: true })
    }
    renameSync(temp, target)
  }
  catch (error) {
    rmSync(temp, { force: true })
    throw new Error(`TURNREWIND_RESTORE_FAILED: ${path}: ${error.message}`)
  }
  return { path, result: 'restored' }
}

export function pathIsSafe(workspaceDir, path) {
  try {
    assertSafePath(workspaceDir, path)
    return true
  }
  catch {
    return false
  }
}

export { gitRef, MAX_FILE_BYTES }
