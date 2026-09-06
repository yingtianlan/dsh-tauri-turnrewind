/**
 * host/service/planner.ts — undo 计划的子树聚合与冲突分类（纯函数）。
 */

import type { DiskState, PathState } from '../types'
import type { TurnRow } from './ledger'
import { planPathsDigest } from './ledger'

/** 叶序收集 turn 及其全部后代（父撤销的递归范围）。 */
export function collectDescendantTurns(turn: TurnRow, childrenByParent: Map<string, TurnRow[]>): TurnRow[] {
  const result: TurnRow[] = []
  const visit = (current: TurnRow): void => {
    for (const child of childrenByParent.get(current.turn_id) ?? []) {
      visit(child)
      result.push(child)
    }
  }
  visit(turn)
  result.push(turn)
  return result
}

export interface PathPlanEntry {
  path: string
  firstTurn: string
  lastTurn: string
}

/** 聚合多 turn 的路径计划：重叠路径以区间（first→last）表示，不重复。 */
export function aggregatePathPlan(turns: TurnRow[], pathReader: (turn: TurnRow) => string[]): PathPlanEntry[] {
  const byPath = new Map<string, PathPlanEntry>()
  for (const turn of turns) {
    for (const path of pathReader(turn)) {
      const current = byPath.get(path)
      if (!current) {
        byPath.set(path, { path, firstTurn: turn.turn_id, lastTurn: turn.turn_id })
      }
      else {
        current.lastTurn = turn.turn_id
      }
    }
  }
  return [...byPath.values()]
}

export function classifyUndo(current: DiskState, expected: PathState): 'safe' | 'conflict' {
  if (current.kind !== expected.kind)
    return 'conflict'
  if (current.digest !== expected.digest)
    return 'conflict'
  return 'safe'
}

/** pending plan 中参与漂移校验的绑定列（P1-2）。 */
export interface PendingPlanBinding {
  before_ref: string | null
  after_ref: string | null
  paths_digest: string | null
}

/**
 * 计划漂移校验（P1-2）：确认时的 turn 快照 ref 与重算 diff 必须与预览一致，
 * 即「确认的就是预览时看到的」。绑定列为 NULL 的旧格式 plan（无从校验）
 * 从严处理：一律按漂移拒绝并要求重新预览——宁可多看一次预览，
 * 不可在不可验证的计划上执行恢复。
 */
export function planDrift(plan: PendingPlanBinding, target: TurnRow, currentPaths: string[]): string | undefined {
  if (plan.before_ref === null || plan.after_ref === null || plan.paths_digest === null)
    return 'the plan predates preview binding and cannot be verified'
  if (target.before_ref !== plan.before_ref || target.after_ref !== plan.after_ref)
    return 'the turn snapshots no longer match the preview'
  if (planPathsDigest(currentPaths) !== plan.paths_digest)
    return 'the change set no longer matches the preview'
  return undefined
}
