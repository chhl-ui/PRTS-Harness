/**
 * `prts memory` 子命令的行为测试。
 *
 * 钉住三件事：默认不改库（retire 是 dry-run）、`--apply` 才写事件、恢复能让
 * 退役项重新可见。用临时库直接调 `memoryCommand`（它返回退出码、不 process.exit），
 * 所以不需要起子进程。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/index.ts'
import { memoryCommand } from '../../src/cli/memory.ts'
import { makeTmp } from '../support/tmp.ts'

function capture(fn: () => number): { code: number; out: string } {
  const lines: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a: unknown[]) => { lines.push(a.map((x) => String(x)).join(' ')) }
  console.error = (...a: unknown[]) => { lines.push(a.map((x) => String(x)).join(' ')) }
  try {
    const code = fn()
    return { code, out: lines.join('\n') }
  } finally {
    console.log = origLog
    console.error = origErr
  }
}

function seed(prefix: string, n = 2): { dbPath: string; ids: string[]; cleanup: () => void } {
  const t = makeTmp(prefix)
  const dbPath = t.db()
  const store = MemoryStore.open(dbPath)
  const ids: string[] = []
  try {
    for (let i = 0; i < n; i++) {
      ids.push(store.assertFact({
        actor: 'owner', subject: '博士', predicate: `偏好${i}`, object: `光学镜头 ${i}`,
        provenance: 'stated', confirmationBasis: 'owner-stated',
      }))
    }
  } finally {
    store.close()
  }
  return { dbPath, ids, cleanup: () => t.cleanup() }
}

function countEvents(dbPath: string, kind: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return (db.prepare('SELECT count(*) c FROM memory_events WHERE kind = ?').get(kind) as { c: number }).c
  } finally {
    db.close()
  }
}

test('MC1 stats 输出 live 计数并返回 0', () => {
  const s = seed('prts-cli-mem-stats-')
  try {
    const { code, out } = capture(() => memoryCommand(['stats', '--db', s.dbPath]))
    assert.equal(code, 0)
    assert.match(out, /live=2/)
    assert.match(out, /retired=0/)
    assert.match(out, /entities=0/)
    assert.match(out, /profiles=0/)
  } finally {
    s.cleanup()
  }
})

test('MC2 retire 默认 dry-run：报告候选但不写库', () => {
  const s = seed('prts-cli-mem-dry-')
  try {
    const { code, out } = capture(() => memoryCommand(['retire', '--db', s.dbPath, '--floor', '0.99', '--min-age-days', '0']))
    assert.equal(code, 0)
    assert.match(out, /candidates=2/)
    assert.match(out, /dry-run/)
    assert.equal(countEvents(s.dbPath, 'fact.retired'), 0, 'dry-run 不得写事件')
  } finally {
    s.cleanup()
  }
})

test('MC3 retire --apply 才写事件，之后 live 归零', () => {
  const s = seed('prts-cli-mem-apply-')
  try {
    const applied = capture(() => memoryCommand([
      'retire', '--db', s.dbPath, '--floor', '0.99', '--min-age-days', '0', '--apply',
    ]))
    assert.equal(applied.code, 0)
    assert.match(applied.out, /retired=2/)
    assert.equal(countEvents(s.dbPath, 'fact.retired'), 2)

    const after = capture(() => memoryCommand(['stats', '--db', s.dbPath]))
    assert.match(after.out, /live=0/)
    assert.match(after.out, /retired=2/)
  } finally {
    s.cleanup()
  }
})

test('MC4 restore 让退役项回到 live；无 id 时返回 2', () => {
  const s = seed('prts-cli-mem-restore-')
  try {
    capture(() => memoryCommand(['retire', '--db', s.dbPath, '--floor', '0.99', '--min-age-days', '0', '--apply']))
    const restored = capture(() => memoryCommand(['restore', s.ids[0] as string, '--db', s.dbPath]))
    assert.equal(restored.code, 0)
    assert.match(restored.out, /restored=1/)

    const after = capture(() => memoryCommand(['stats', '--db', s.dbPath]))
    assert.match(after.out, /live=1/)
    assert.match(after.out, /retired=1/)

    const noId = capture(() => memoryCommand(['restore', '--db', s.dbPath]))
    assert.equal(noId.code, 2)
  } finally {
    s.cleanup()
  }
})

test('MC5 未知子命令 / 缺库路径都返回 2', () => {
  const s = seed('prts-cli-mem-usage-')
  try {
    assert.equal(capture(() => memoryCommand(['nope', '--db', s.dbPath])).code, 2)
    assert.equal(capture(() => memoryCommand([])).code, 2)

    const saved = { db: process.env.PRTS_MEMORY_DB, root: process.env.PRTS_DATA_ROOT }
    delete process.env.PRTS_MEMORY_DB
    delete process.env.PRTS_DATA_ROOT
    try {
      assert.equal(capture(() => memoryCommand(['stats'])).code, 2, '无 --db 也没环境变量时必须报错')
    } finally {
      if (saved.db !== undefined) process.env.PRTS_MEMORY_DB = saved.db
      if (saved.root !== undefined) process.env.PRTS_DATA_ROOT = saved.root
    }
  } finally {
    s.cleanup()
  }
})

test('MC6 consolidate 在空库上返回 0 并输出可解析的 JSON', () => {
  const s = seed('prts-cli-mem-cons-')
  try {
    const { code, out } = capture(() => memoryCommand(['consolidate', '--db', s.dbPath]))
    assert.equal(code, 0)
    const parsed = JSON.parse(out.trim().split('\n').at(-1) as string) as { turns: number; cursor: number }
    assert.equal(typeof parsed.turns, 'number')
    assert.equal(parsed.turns, 0, '库内没有 turn，规则巩固应处理 0 条')
  } finally {
    s.cleanup()
  }
})
