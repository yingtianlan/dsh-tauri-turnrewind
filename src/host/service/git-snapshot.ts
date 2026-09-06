/**
 * host/service/git-snapshot.ts — 私有快照仓库与路径恢复（git-dir 模式核心）。
 *
 * 模型（OpenCode 式）：每个 Git worktree 一个私有 snapshot repo（DSH_HOME/snapshots/
 * <hash>.git），通过 objects/info/alternates 借用源仓库对象；capture 用临时
 * GIT_INDEX_FILE 与源 ignore 语义；undo 只重写工作区文件，绝不触碰用户 HEAD/
 * branch/index/stash（git-state.test 钉死）。
 *
 * 安全边界：路径逃逸/symlink 拒绝、恢复前尺寸检查、外部击杀 reject（不 resolve
 * 半截输出）、超限 blob 单文件报告（tooLarge），以及 alternates 失效自愈
 * （rev-list --missing=print 检测 → 自包含重建）。
 */

import type {
  DiskState,
  PathChange,
  PathState,
  RestoreResult,
  Snapshot,
  SnapshotStore,
  WorkspaceProbe,
} from '../types'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { dirname, join, relative, resolve, sep } from 'pathe'
import {
  BAK_SUFFIX,
  GIT_PROBE_RETRY_MS,
  GIT_PROBE_TIMEOUT_MS,
  GIT_SUBPROCESS_TIMEOUT_MS,
  GIT_SYMLINK_MODE,
  MAX_FILE_BYTES,
  MAX_OUTPUT_BYTES,
  SNAPSHOT_PATHSPECS,
  SNAPSHOT_REF_PREFIX,
} from '../constants'
import { gitUnavailableReason, gitWorkspace } from './git-workspace'

/** 退出判定：只有干净退出（code 0、无信号）才可 resolve。 */
export function gitExitIsClean(code: number | null, signal: NodeJS.Signals | null): boolean {
  const noSignal = signal === null || signal === undefined
  return code === 0 && noSignal
}

/**
 * 异步执行一条 git 命令（不阻塞事件循环）。SIGKILL 预算防卡死；外部击杀
 * （close(null, signal) 且非自身超时）reject——resolve 半截输出会把残缺 index
 * 提交成 turn 快照。
 */
export function runGit(
  repoDir: string,
  workspaceDir: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  maxBytes: number = MAX_OUTPUT_BYTES,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '--git-dir', repoDir, '--work-tree', workspaceDir, ...args], {
      cwd: workspaceDir,
      env: { ...process.env, ...extraEnv },
    })
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    let total = 0
    let settled = false
    let timeout: ReturnType<typeof setTimeout>
    const fail = (error: Error): void => {
      if (settled)
        return
      settled = true
      clearTimeout(timeout)
      child.kill('SIGKILL')
      rejectPromise(error)
    }
    // SIGKILL so a git stuck in uninterruptible I/O cannot outlive the budget.
    timeout = setTimeout(
      () => fail(new Error(`TURNREWIND_GIT_TIMEOUT: git ${args.join(' ')} exceeded ${GIT_SUBPROCESS_TIMEOUT_MS / 1000}s`)),
      GIT_SUBPROCESS_TIMEOUT_MS,
    )
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled)
        return
      total += chunk.length
      if (total > maxBytes) {
        fail(new Error(`TURNREWIND_OUTPUT_TOO_LARGE: git output exceeded ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (!settled)
        errors.push(chunk)
    })
    child.on('error', error => fail(new Error(`TURNREWIND_GIT_EXEC: ${error.message}`)))
    child.on('close', (code, signal) => {
      if (settled)
        return
      const stdout = Buffer.concat(chunks)
      // A clean exit is the only path that resolves (see gitExitIsClean).
      // Our own timeout kill already settled above, so anything unclean
      // here is an external kill with truncated output.
      if (!gitExitIsClean(code, signal)) {
        const detail = Buffer.concat(errors).toString('utf8').trim() || stdout.toString('utf8').trim() || (signal ? `killed by ${signal}` : `exit ${code}`)
        fail(new Error(`TURNREWIND_GIT_FAILED: ${detail}`))
        return
      }
      settled = true
      clearTimeout(timeout)
      resolvePromise(stdout)
    })
  })
}

/** 导出给 doctor 等只读诊断使用（与 runGit 同一击杀/超时语义）。 */
export async function runGitText(repoDir: string, workspaceDir: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const output = await runGit(repoDir, workspaceDir, args, extraEnv)
  return output.toString('utf8')
}

/** 带管道输入的 git 执行（hash-object -w --stdin 等）；同样的击杀/超时语义。 */
function runGitStdin(repoDir: string, workspaceDir: string, args: string[], input: Buffer | string): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '--git-dir', repoDir, '--work-tree', workspaceDir, ...args], {
      cwd: workspaceDir,
      env: { ...process.env },
    })
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    let settled = false
    let timeout: NodeJS.Timeout
    const fail = (error: Error): void => {
      if (settled)
        return
      settled = true
      clearTimeout(timeout)
      child.kill('SIGKILL')
      rejectPromise(error)
    }
    timeout = setTimeout(
      () => fail(new Error(`TURNREWIND_GIT_TIMEOUT: git ${args.join(' ')} exceeded ${GIT_SUBPROCESS_TIMEOUT_MS / 1000}s`)),
      GIT_SUBPROCESS_TIMEOUT_MS,
    )
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
    child.on('error', error => fail(new Error(`TURNREWIND_GIT_EXEC: ${error.message}`)))
    child.on('close', (code, signal) => {
      if (settled)
        return
      // Unclean exit = external kill with truncated output (our own timeout
      // settled above). fail() owns the settled flag so the promise settles.
      if (!gitExitIsClean(code, signal)) {
        fail(new Error(`TURNREWIND_GIT_FAILED: ${Buffer.concat(errors).toString('utf8').trim() || (signal ? `killed by ${signal}` : `exit ${code}`)}`))
        return
      }
      settled = true
      clearTimeout(timeout)
      resolvePromise(Buffer.concat(chunks))
    })
    // Ignore EPIPE if git exits before consuming all input.
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

let gitProbeResult: Promise<boolean> | undefined
let gitProbeFailedAt = 0

/**
 * PATH 上是否有可用的 git。成功探测进程级缓存；失败探测按 GIT_PROBE_RETRY_MS
 * 过期重试（进程内装好 git/修好 PATH 无需重启 Host）。探测喂给 pre-step barrier，
 * 无预算挂起的 `git --version` 会永远卡住 turn。
 */
export function gitAvailable(): Promise<boolean> {
  const failedRecently = gitProbeResult !== undefined && gitProbeFailedAt > 0 && Date.now() - gitProbeFailedAt > GIT_PROBE_RETRY_MS
  if (failedRecently) {
    gitProbeResult = undefined
    gitProbeFailedAt = 0
  }
  gitProbeResult ??= new Promise<boolean>((resolvePromise) => {
    const child = spawn('git', ['--version'])
    let settled = false
    let probeTimeout: NodeJS.Timeout
    const settle = (value: boolean): void => {
      if (settled)
        return
      settled = true
      clearTimeout(probeTimeout)
      resolvePromise(value)
    }
    const markFailure = (): void => {
      gitProbeFailedAt = Date.now()
    }
    probeTimeout = setTimeout(() => {
      markFailure()
      child.kill('SIGKILL')
      settle(false)
    }, GIT_PROBE_TIMEOUT_MS)
    child.on('error', () => {
      markFailure()
      settle(false)
    })
    child.on('close', (code, signal) => {
      if (code !== 0 || signal !== null)
        markFailure()
      settle(code === 0 && signal === null)
    })
  })
  return gitProbeResult
}

async function ensureRepository(store: SnapshotStore): Promise<void> {
  const { repoDir, workspaceDir, sourceCommonDir, sourceInfoExclude } = store
  const source = gitWorkspace(workspaceDir)
  if (!source || source.gitDir !== store.sourceGitDir)
    throw new Error(`TURNREWIND_GIT_REPOSITORY: ${workspaceDir} is not the expected Git worktree`)
  if (!existsSync(join(repoDir, 'HEAD'))) {
    mkdirSync(dirname(repoDir), { recursive: true })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn('git', ['init', '--bare', repoDir])
      const errors: Buffer[] = []
      let settled = false
      const timeout = setTimeout(() => {
        settled = true
        child.kill('SIGKILL')
        rejectPromise(new Error(`TURNREWIND_GIT_TIMEOUT: git init exceeded ${GIT_SUBPROCESS_TIMEOUT_MS / 1000}s`))
      }, GIT_SUBPROCESS_TIMEOUT_MS)
      child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
      child.on('error', (error: Error) => {
        if (settled)
          return
        settled = true
        clearTimeout(timeout)
        rejectPromise(new Error(`TURNREWIND_GIT_INIT: ${error.message}`))
      })
      child.on('close', (code, signal) => {
        if (settled)
          return
        settled = true
        clearTimeout(timeout)
        if (!gitExitIsClean(code, signal)) {
          const detail = Buffer.concat(errors).toString('utf8').trim() || (signal ? `killed by ${signal}` : `exit ${code}`)
          const errorCode = signal ? 'TURNREWIND_GIT_FAILED' : 'TURNREWIND_GIT_INIT'
          rejectPromise(new Error(`${errorCode}: ${detail}`))
          return
        }
        resolvePromise()
      })
    })
    await runGitText(repoDir, workspaceDir, ['config', 'core.autocrlf', 'false'])
    await runGitText(repoDir, workspaceDir, ['config', 'core.symlinks', 'true'])
    await runGitText(repoDir, workspaceDir, ['config', 'core.longpaths', 'true'])

    // Reuse committed source objects, as OpenCode does, while new snapshot
    // objects stay in this private repository. A healed store stays
    // self-contained: alternates are never written again, so source-side
    // gc/prune can no longer break snapshot chains for this workspace.
    if (store.selfContained !== true) {
      const sourceObjects = join(sourceCommonDir, 'objects')
      if (existsSync(sourceObjects)) {
        const alternates = join(repoDir, 'objects', 'info', 'alternates')
        mkdirSync(dirname(alternates), { recursive: true })
        writeFileSync(alternates, `${sourceObjects}\n`)
      }
    }
  }
  if (sourceInfoExclude && existsSync(sourceInfoExclude)) {
    const exclude = join(repoDir, 'info', 'exclude')
    mkdirSync(dirname(exclude), { recursive: true })
    writeFileSync(exclude, readFileSync(sourceInfoExclude))
  }
}

function normalizeSnapshotRef(ref: string): string {
  if (typeof ref !== 'string' || !ref.startsWith(SNAPSHOT_REF_PREFIX) || ref.includes('..') || ref.includes(String.fromCharCode(92)) || ref.includes('//'))
    throw new Error(`TURNREWIND_REF_UNSUPPORTED: ${String(ref)}`)
  return ref
}

/**
 * P2-11: 所有插值进 git 参数的 commit/reffed 参数统一过校验——只接受
 * `refs/turnrewind/*` ref 名或 40 位 SHA（gitRef/captureSnapshot 的返回
 * 形态）。ledger 之外的取值在这里被拦下，而不是散落到各 git 子进程。
 */
function assertCommitRef(commit: string): string {
  if (typeof commit !== 'string' || !(commit.startsWith(SNAPSHOT_REF_PREFIX) || /^[0-9a-f]{40}$/.test(commit)))
    throw new Error(`TURNREWIND_REF_UNSUPPORTED: ${String(commit)}`)
  return commit
}

export async function gitRef(repoDir: string, workspaceDir: string, ref: string): Promise<string | undefined> {
  try {
    const output = await runGitText(repoDir, workspaceDir, ['rev-parse', '--verify', normalizeSnapshotRef(ref)])
    return output.trim()
  }
  catch {
    return undefined
  }
}

function assertSafePath(workspaceDir: string, path: string): string {
  const root = resolve(workspaceDir)
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new Error(`TURNREWIND_PATH_ESCAPE: ${path}`)
  // Defense in depth: the workspace root itself is never a restorable path.
  // A path that normalizes to the root would make a restore delete the whole
  // workspace instead of one file.
  if (target === root)
    throw new Error(`TURNREWIND_PATH_ESCAPE: ${path} (workspace root cannot be restored)`)

  let current = root
  const suffix = relative(root, target)
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part)
    // lstatSync must be used without an existsSync pre-check: existsSync
    // returns false for dangling links, but a dangling link is still an unsafe
    // path component and must never be replaced or traversed.
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error(`TURNREWIND_SYMLINK_UNSUPPORTED: ${path}`)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ENOTDIR')
        continue
      throw error
    }
  }
  return target
}

/**
 * Canonical workspace identity shared by the ledger key, the snapshot repo
 * hash and maintenance purges: case-folded on case-insensitive platforms
 * (Windows NTFS, macOS APFS default) so one directory cannot spawn two
 * snapshot domains; Linux stays byte-exact. `platform` is injectable for tests.
 */
export function workspaceKey(workspaceDir: string, platform: string = process.platform): string {
  const normalized = resolve(workspaceDir)
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized
}

export function workspaceHash(workspaceDir: string): string {
  return createHash('sha256').update(workspaceKey(workspaceDir)).digest('hex').slice(0, 24)
}

/**
 * Create one OpenCode-style private snapshot repository per Git worktree.
 * The source Git directory is read-only metadata/object input; the snapshot
 * repository keeps its own refs and alternate capture index.
 */
export function createSnapshotStore(rootDir: string, workspaceDir: string): SnapshotStore {
  const source = gitWorkspace(workspaceDir)
  if (!source)
    throw new Error(gitUnavailableReason() ?? `TURNREWIND_GIT_REQUIRED: ${resolve(workspaceDir)} is not a Git worktree`)
  const normalizedWorkspace = source.workspaceDir
  const repoDir = join(rootDir, 'snapshots', `${workspaceHash(normalizedWorkspace)}.git`)
  return {
    rootDir,
    repoDir,
    workspaceDir: normalizedWorkspace,
    sourceGitDir: source.gitDir,
    sourceCommonDir: source.commonDir,
    sourceIndexPath: source.indexPath,
    sourceInfoExclude: source.infoExcludePath ?? '',
  }
}

/**
 * Git mode deliberately avoids a second full filesystem budget walk. The
 * project's Git ignore rules determine the snapshot surface; restore keeps a
 * per-file size limit because snapshot contents still have to fit in memory.
 */
export function probeWorkspace(workspaceDir: string): WorkspaceProbe {
  const source = gitWorkspace(workspaceDir)
  if (!source)
    return { ok: false, reason: gitUnavailableReason() ?? 'TURNREWIND_GIT_REQUIRED: workspace is not a Git worktree' }
  return { ok: true, workspaceDir: source.workspaceDir, commonDir: source.commonDir }
}

/**
 * Capture a snapshot, then verify every referenced object is still readable
 * through the snapshot repository (including its alternates). The source
 * repository can prune exactly the unreachable objects we borrowed —
 * `git gc --prune=now` after an amend/rebase is the everyday case — so a
 * capture that reuses a parent chain may silently reference deleted blobs.
 * When that happens, rebuild the store as a self-contained repository (no
 * alternates, no source-index seeding) and take a fresh baseline: old turns
 * become dead snapshots the planner already skips, and future turns never
 * borrow again.
 */
export async function captureSnapshot(store: SnapshotStore, refName: string, message: string, parentRef?: string): Promise<Snapshot> {
  let snapshot = await captureInto(store, refName, message, parentRef)
  if (await snapshotHasMissingObjects(store, snapshot.commit)) {
    console.warn(`turnrewind: snapshot objects for ${store.workspaceDir} disappeared from the source repository (gc/prune); rebuilding a self-contained baseline`)
    rmSync(store.repoDir, { recursive: true, force: true })
    store.selfContained = true
    snapshot = await captureInto(store, refName, message, undefined)
    if (await snapshotHasMissingObjects(store, snapshot.commit))
      throw new Error(`TURNREWIND_SNAPSHOT_INCOMPLETE: ${store.workspaceDir} baseline still misses objects after a self-contained rebuild`)
  }
  return snapshot
}

/**
 * `git rev-list --objects --missing=print` walks every object reachable from
 * the commit (through alternates) and prints missing ones as `?<oid>` lines
 * while exiting 0, so detection stays non-fatal on healthy stores.
 */
async function snapshotHasMissingObjects(store: SnapshotStore, commit: string): Promise<boolean> {
  try {
    const output = await runGit(store.repoDir, store.workspaceDir, ['rev-list', '--objects', '--missing=print', commit])
    return output.toString('utf8').split('\n').some(line => line.startsWith('?'))
  }
  catch (error) {
    // Detection must never take healthy snapshots down: an unusable probe
    // (very old git, transient failure) only skips the self-heal path.
    console.warn(`turnrewind: snapshot connectivity check failed for ${store.workspaceDir}: ${(error as Error).message}`)
    return false
  }
}

async function captureInto(store: SnapshotStore, refName: string, message: string, parentRef?: string): Promise<Snapshot> {
  const { repoDir, workspaceDir, sourceIndexPath } = store
  await ensureRepository(store)
  let parent: string | undefined
  if (parentRef) {
    parent = await gitRef(repoDir, workspaceDir, parentRef)
    if (!parent)
      console.warn(`turnrewind: snapshot parent ${parentRef} is gone; building a fresh baseline for ${workspaceDir}`)
  }
  const indexPath = join(tmpdir(), `turnrewind-index-${randomUUID()}`)
  try {
    const env = { GIT_INDEX_FILE: indexPath }
    if (parent)
      await runGit(repoDir, workspaceDir, ['read-tree', parent], env)
    else if (store.selfContained !== true && existsSync(sourceIndexPath))
      copyFileSync(sourceIndexPath, indexPath)
    // Git reads .gitignore and global excludes from the source worktree while
    // GIT_INDEX_FILE isolates the snapshot from the user's real index.
    await runGit(repoDir, workspaceDir, ['add', '--all', '--', '.', ...SNAPSHOT_PATHSPECS], env)
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
    const ref = normalizeSnapshotRef(refName)
    await runGit(repoDir, workspaceDir, ['update-ref', ref, commit])
    return { commit, refName: ref }
  }
  finally {
    rmSync(indexPath, { force: true })
  }
}

export async function snapshotDiff(store: SnapshotStore, beforeCommit: string, afterCommit: string): Promise<string[]> {
  assertCommitRef(beforeCommit)
  assertCommitRef(afterCommit)
  const output = await runGit(store.repoDir, store.workspaceDir, ['diff', '--name-only', '-z', '--no-renames', beforeCommit, afterCommit])
  return [...new Set(output.toString('utf8').split('\0').filter(Boolean))]
}

const DEFAULT_MAX_DIFF_LINES = 120

function truncateDiff(text: string, maxLines: number = DEFAULT_MAX_DIFF_LINES): string {
  const lines = text.replace(/\n$/u, '').split('\n')
  if (lines.length <= maxLines || lines[0] === '')
    return lines[0] === '' ? '' : lines.join('\n')
  return `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more line(s) truncated)`
}

/** Classify how one path changed between two snapshots: created, deleted, or modified. */
export async function classifyPathChange(store: SnapshotStore, beforeCommit: string, afterCommit: string, path: string): Promise<PathChange> {
  const before = await stateAt(store, beforeCommit, path)
  const after = await stateAt(store, afterCommit, path)
  if (before.kind === 'absent' && (after.kind === 'file' || after.kind === 'unsupported'))
    return 'created'
  if ((before.kind === 'file' || before.kind === 'tooLarge' || before.kind === 'unsupported') && after.kind === 'absent')
    return 'deleted'
  return 'modified'
}

/** Unified diff of one path between two snapshot commits, truncated to maxLines. */
export async function snapshotFileDiff(store: SnapshotStore, fromCommit: string, toCommit: string, path: string, maxLines?: number): Promise<string> {
  assertCommitRef(fromCommit)
  assertCommitRef(toCommit)
  // --ignore-cr-at-eol 与冲突检测的 CRLF 规范化同语义：换行符翻转不画成
  // 幽灵增删（同一行删一遍又加一遍），预览只呈现内容变化。
  const output = await runGit(store.repoDir, store.workspaceDir, ['diff', '--no-renames', '--ignore-cr-at-eol', fromCommit, toCommit, '--', path])
  return truncateDiff(output.toString('utf8'), maxLines)
}

// The well-known empty blob is not pre-populated in a fresh private repo, so
// write it on first use (its hash is always e69de29bb2d1d6434b8b29ae775ad8c2e48c5391).
async function ensureEmptyBlob(store: SnapshotStore): Promise<string> {
  if (!store.emptyBlob) {
    const output = await runGitStdin(store.repoDir, store.workspaceDir, ['hash-object', '-w', '--stdin'], '')
    store.emptyBlob = output.toString('utf8').trim()
  }
  return store.emptyBlob
}

async function blobFor(store: SnapshotStore, commit: string, path: string): Promise<string> {
  if (!await commitEntryInfo(store, commit, path))
    return ensureEmptyBlob(store)
  return (await runGit(store.repoDir, store.workspaceDir, ['rev-parse', `${commit}:${path}`])).toString('utf8').trim()
}

async function hashDiskFile(store: SnapshotStore, workspaceDir: string, path: string): Promise<string | undefined> {
  const target = assertSafePath(workspaceDir, path)
  if (!existsSync(target))
    return ensureEmptyBlob(store)
  const info = lstatSync(target)
  if (!info.isFile() || info.size > MAX_FILE_BYTES)
    return undefined
  const output = await runGitStdin(store.repoDir, store.workspaceDir, ['hash-object', '-w', '--stdin'], await readFile(target))
  return output.toString('utf8').trim()
}

/**
 * Unified diff between a path's committed state and its current on-disk content.
 * Used to show what a human (or another session) changed after a turn, i.e. the
 * content an undo would overwrite. The disk content is hashed into the private
 * snapshot repo; the user's own repository is never touched.
 */
export async function diffAgainstDisk(store: SnapshotStore, commit: string, path: string, maxLines?: number): Promise<string> {
  assertCommitRef(commit)
  const from = await blobFor(store, commit, path)
  const to = await hashDiskFile(store, store.workspaceDir, path)
  if (to === undefined)
    return '(current file is not a regular file or exceeds the size limit)'
  if (from === to)
    return ''
  const output = await runGit(store.repoDir, store.workspaceDir, [
    'diff',
    '--no-renames',
    '--ignore-cr-at-eol',
    '--src-prefix=snapshot/',
    '--dst-prefix=disk/',
    from,
    to,
  ])
  return truncateDiff(output.toString('utf8'), maxLines)
}

/**
 * 一次 `ls-tree -l` 读取条目的 mode、type 与 size：stateAt/restorePath/blobFor
 * 共用，避免同一路径多次子进程调用。size 为 undefined 表示未知（submodule）。
 */
interface CommitEntryInfo {
  mode: string
  type: string
  size: number | undefined
}

async function commitEntryInfo(store: SnapshotStore, commit: string, path: string): Promise<CommitEntryInfo | undefined> {
  const output = await runGit(store.repoDir, store.workspaceDir, ['ls-tree', '-r', '-l', '-z', commit, '--', path])
  for (const line of output.toString('utf8').split('\0')) {
    // mode SP type SP oid TAB size SP path (size is '-' for submodules).
    const tab = line.lastIndexOf('\t')
    if (tab !== -1 && line.slice(tab + 1) === path) {
      const meta = line.slice(0, tab).split(' ')
      const size = Number(meta.at(-1))
      return {
        mode: meta[0] ?? '100644',
        type: meta[1] ?? 'blob',
        size: Number.isFinite(size) && meta.at(-1) !== '-' ? size : undefined,
      }
    }
  }
  return undefined
}

async function commitBytes(store: SnapshotStore, commit: string, path: string): Promise<Buffer> {
  const output = await runGit(store.repoDir, store.workspaceDir, ['show', `${commit}:${path}`], {}, MAX_FILE_BYTES + 1)
  if (output.length > MAX_FILE_BYTES)
    throw new Error(`TURNREWIND_FILE_TOO_LARGE: ${path}`)
  return output
}

function digest(bytes: Buffer): string {
  let comparable: Uint8Array = bytes
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    comparable = new TextEncoder().encode(text.replaceAll('\r\n', '\n'))
  }
  catch {
    // Binary data has no newline normalization; compare its exact bytes.
  }
  return createHash('sha256').update(comparable).digest('hex')
}

export async function stateAt(store: SnapshotStore, commit: string, path: string): Promise<PathState> {
  // stateAt only inspects the private snapshot repo (commit:path revisions),
  // never the filesystem.
  // P1-3: a symlink entry ('120000') must not masquerade as a regular file —
  // its blob is just the link target text. Report it as unsupported so the
  // plan flags it and restore refuses, instead of writing wrong content.
  // P2-11: gitlink/submodule 条目（type 'commit'）同样 unsupported——blob 是
  // commit hash，写回会是错误内容。
  assertCommitRef(commit)
  const info = await commitEntryInfo(store, commit, path)
  if (!info)
    return { kind: 'absent', digest: null }
  if (info.mode === GIT_SYMLINK_MODE || info.type === 'commit')
    return { kind: 'unsupported', digest: null }
  // Oversized blobs are reported instead of thrown: the caller can mark the
  // entry and continue, so one huge file never aborts a whole undo preview.
  if ((info.size ?? 0) > MAX_FILE_BYTES)
    return { kind: 'tooLarge', digest: null }
  const bytes = await commitBytes(store, commit, path)
  return { kind: 'file', digest: digest(bytes), mode: info.mode }
}

export async function currentState(workspaceDir: string, path: string): Promise<DiskState> {
  const target = assertSafePath(workspaceDir, path)
  if (!existsSync(target))
    return { kind: 'absent', digest: null }
  const info = lstatSync(target)
  if (!info.isFile() || info.size > MAX_FILE_BYTES)
    return { kind: 'unsupported', digest: null }
  // Windows 无法可靠识别可执行位（git core.filemode=false），统一按 100644 报告；
  // POSIX 取真实权限位，使 mode 差异能进入冲突可视与恢复路径。文件读取走异步，
  // 大文件的冲突检测不再阻塞事件循环。
  const mode = process.platform === 'win32'
    ? '100644'
    : `100${(info.mode & 0o777).toString(8).padStart(3, '0')}`
  return { kind: 'file', digest: digest(await readFile(target)), mode }
}

/**
 * Remove one path, retrying briefly: Windows antivirus/indexers hold
 * short-lived handles on freshly written files, and a transient EPERM/EBUSY
 * on the .bak delete must not fail an otherwise successful restore.
 */
function rmSyncWithRetry(target: string, attempts: number = 5): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(target, { force: true })
      return
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
      if (retryable && attempt < attempts) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
        continue
      }
      throw error
    }
  }
}

/**
 * Crash-safe restore window. The pre-atomic sequence was delete-then-rename:
 * a crash between those two steps left the target missing and its only copy
 * in a .tmp file nobody resurrected. The swap keeps a complete copy on disk at
 * every instant:
 *
 *   target -> target.turnrewind-restore.bak   (rename, atomic)
 *   temp   -> target                          (rename, atomic)
 *   bak    -> deleted                         (only after success)
 *
 * A crash anywhere leaves either the new content or the .bak; the startup
 * sweep (restoreCrashedSwaps) resurrects a .bak whose target is missing.
 */
export async function restorePath(store: SnapshotStore, commit: string, path: string): Promise<RestoreResult> {
  assertCommitRef(commit)
  let target = assertSafePath(store.workspaceDir, path)
  const entry = await commitEntryInfo(store, commit, path)
  // P1-5: the git subprocess above opens a TOCTOU window — an external
  // process can swap a parent directory for a symlink/junction in that gap.
  // Re-validate the full component chain immediately before any filesystem
  // mutation; the walk is a handful of lstats, cheap per restored path.
  target = assertSafePath(store.workspaceDir, path)
  if (!entry) {
    if (existsSync(target)) {
      const info = lstatSync(target)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path}`)
      if (info.isDirectory()) {
        // The turn replaced a file with a directory, or the user built a
        // directory at this path after the snapshot. Recursively deleting it
        // can destroy unrelated files that the turn never touched (files
        // ignored by git are not even in the snapshot). Refuse loudly; only
        // an EMPTY directory is removed, since it holds nothing to lose.
        const contents = readdirSync(target)
        if (contents.length > 0)
          throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path} is now a non-empty directory; undo will not recursively delete it (remove it manually if intended)`)
        assertSafePath(store.workspaceDir, path)
        // rmdirSync only succeeds on an empty directory: rmSync without
        // recursive throws ERR_FS_EISDIR, and with recursive a file planted
        // between readdir and the delete would be destroyed with the tree.
        rmdirSync(target)
      }
      else {
        assertSafePath(store.workspaceDir, path)
        rmSync(target, { force: true })
      }
    }
    return { path, result: 'removed' }
  }

  // P1-3/P2-11: symlink 与 gitlink/submodule 条目绝不能以普通文件形式写回
  // （前者内容是 link target，后者是 commit hash）。单路径稳定错误码，
  // undo 循环计入未恢复清单而不是破坏工作区类型。
  if (entry.mode === GIT_SYMLINK_MODE || entry.type === 'commit')
    throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path} is a symlink or submodule in the snapshot; undo cannot restore it (recreate it manually if intended)`)

  // Restoring an oversized blob would require materializing it through the
  // same output-limited channel. Fail this one path with a stable code so the
  // undo loop can report it as not restored instead of dying mid-plan.
  if ((entry.size ?? 0) > MAX_FILE_BYTES)
    throw new Error(`TURNREWIND_FILE_TOO_LARGE: ${path} (${MAX_FILE_BYTES}-byte limit) cannot be restored; add it to .gitignore or restore it manually`)
  const bytes = await commitBytes(store, commit, path)
  // P1-5: second re-validation after the second async subprocess gap.
  target = assertSafePath(store.workspaceDir, path)
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.turnrewind-${randomUUID()}.tmp`
  writeFileSync(temp, bytes, { flag: 'wx' })
  // P1-4: restore the snapshot's git mode (executable bit). Windows chmod
  // only toggles the read-only bit, so this is safe cross-platform.
  chmodSync(temp, entry.mode === '100755' ? 0o755 : 0o644)
  let bak: string | undefined
  try {
    if (existsSync(target)) {
      const info = lstatSync(target)
      // A directory (even an empty one) at the target is refused: restoring a
      // file over it must never recurse into unrelated content, with or
      // without --force. The user removes the directory manually instead.
      if (info.isDirectory())
        throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path} is a directory; undo will not delete it to restore a file`)
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error(`TURNREWIND_UNSUPPORTED_TARGET: ${path}`)
      // Move the old content aside instead of deleting it: the swap keeps a
      // complete copy on disk across both renames.
      bak = `${target}${BAK_SUFFIX}`
      rmSync(bak, { force: true })
      assertSafePath(store.workspaceDir, path)
      renameSync(target, bak)
    }
    try {
      // P1-5: last re-validation before the rename places new content — the
      // window between this check and the rename is the narrowest we can get
      // without an fd-based or sandboxed filesystem API.
      assertSafePath(store.workspaceDir, path)
      renameSync(temp, target)
    }
    catch (error) {
      // The swap failed halfway: put the old content back before reporting.
      if (bak !== undefined) {
        try {
          if (!existsSync(target))
            renameSync(bak, target)
          else
            rmSync(bak, { force: true })
        }
        catch { /* best-effort self-heal; a leftover .bak stays recoverable */ }
      }
      throw error
    }
    // New content is in place; the old copy is now redundant. The delete is
    // retried: a transient antivirus handle on the fresh .bak must not turn
    // a completed restore into a reported failure (the sweep cleans a
    // leftover .bak anyway).
    if (bak !== undefined)
      rmSyncWithRetry(bak)
  }
  catch (error) {
    rmSync(temp, { force: true })
    throw new Error(`TURNREWIND_RESTORE_FAILED: ${path}: ${(error as Error).message}`)
  }
  return { path, result: 'restored' }
}

/**
 * Startup sweep for atomic-swap leftovers. A .turnrewind-restore.bak next to
 * a missing target means the process died between the two renames: resurrect
 * the old content. A .bak next to an existing target is debris from a crash
 * after the second rename (before the delete) - safe to remove. Returns the
 * resurrected workspace-relative paths for logging.
 */
export function restoreCrashedSwaps(workspaceDir: string): string[] {
  const root = resolve(workspaceDir)
  const resurrected: string[] = []
  const visit = (dir: string): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    }
    catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      // P2-11: Windows junction 的 Dirent 可能报 isDirectory()——递归进
      // junction 会越过 workspace 边界。目录在进入前先 lstat 排除 reparse
      // point（symlink/junction 均命中 isSymbolicLink）。
      if (entry.isDirectory() && entry.name !== '.git' && !entry.name.endsWith(BAK_SUFFIX)) {
        if (lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink())
          continue
        visit(full)
      }
      if (entry.isFile() && entry.name.endsWith(BAK_SUFFIX)) {
        const target = full.slice(0, -BAK_SUFFIX.length)
        // Windows antivirus/indexers hold brief handles on freshly renamed
        // files; retry a few times before giving this bak up to the fence.
        for (let attempt = 0; ; attempt += 1) {
          try {
            if (!existsSync(target)) {
              renameSync(full, target)
              resurrected.push(relative(root, target))
            }
            else {
              rmSync(full, { force: true })
            }
            break
          }
          catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code
            const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
            if (retryable && attempt < 5) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
              continue
            }
            break // deeper damage: leave for the recovery fence
          }
        }
      }
    }
  }
  visit(root)
  return resurrected
}
