/**
 * P0-2b 会话日志删除。
 *
 * 钉住的契约：
 * - 判定「未在使用」走 DSH 写租约同一协议（命名内核信号量）——
 *   活动会话必须 busy，上游改锁方案时这里的端到端用例应变红而不是假放行。
 * - 持锁-删除-放锁无竞态；在用会话（含当前 chat）天然拒删。
 * - 删完为挂着的 K4 `session-log` derivative 补 done（全部完成自动 completed）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { scriptedLlmPlugin, type ScriptedStep } from '../support/scripted-llm.ts'
import { runTurn } from '../support/drive.ts'
import { makeTmp } from '../support/tmp.ts'
import { AuditLog } from '../../src/audit/audit.ts'
import { acquireSessionLock, findSessionDirs, probeSessions, purgeSessions } from '../../src/memory/session-purge.ts'
import type { Context } from '@deepseek-ai/cordis'

const WIN = process.platform === 'win32'
const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))
const disableLlm = [{ id: 'llm-deepseek', disabled: true }]

function makeSessionDir(root: string, ws: string, id: string, body = 'line\n'): string {
  const dir = join(root, ws, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl'), body)
  return dir
}

/** sessions 根下第一个会话目录名（E2E 用——真实 id 由 DSH 生成）。 */
function anySessionDir(root: string): { id: string; dir: string } | undefined {
  if (!existsSync(root)) return undefined
  for (const ws of readdirSync(root)) {
    const wsDir = join(root, ws)
    for (const id of readdirSync(wsDir)) {
      const dir = join(wsDir, id)
      if (existsSync(join(dir, 'session.v4.jsonl'))) return { id, dir }
    }
  }
  return undefined
}

test('SP1 空闲会话：探测 free，purge 删除整目录', { skip: !WIN }, () => {
  const t = makeTmp('prts-sp1-')
  try {
    const root = join(t.dir, 'sessions')
    const dir = makeSessionDir(root, '--ws--', 'sess-a')
    const probes = probeSessions(root, ['sess-a'])
    assert.equal(probes.length, 1)
    assert.equal(probes[0]!.state, 'free')
    assert.ok(probes[0]!.jsonlBytes > 0)

    const r = purgeSessions({ sessionsRoot: root, sessionIds: ['sess-a'] })
    assert.deepEqual(r.purged, ['sess-a'])
    assert.equal(r.ok, true)
    assert.equal(existsSync(dir), false, '会话目录必须整个消失')
  } finally { t.cleanup() }
})

test('SP2 在用会话：持锁时 busy 且拒删，目录完好', { skip: !WIN }, () => {
  const t = makeTmp('prts-sp2-')
  try {
    const root = join(t.dir, 'sessions')
    const dir = makeSessionDir(root, '--ws--', 'sess-live')
    const lock = acquireSessionLock(dir)
    assert.notEqual(lock, 'busy', '自建锁先拿到，模拟活动写者')
    assert.notEqual(lock, 'unsupported')
    if (typeof lock === 'string') return
    try {
      const probes = probeSessions(root, ['sess-live'])
      assert.equal(probes[0]!.state, 'busy', '锁被占时探测必须报 busy')

      const r = purgeSessions({ sessionsRoot: root, sessionIds: ['sess-live'] })
      assert.equal(r.purged.length, 0)
      assert.ok(r.busy.length > 0)
      assert.equal(existsSync(join(dir, 'session.v4.jsonl')), true, '拒删后日志必须完好')
    } finally { lock.release() }
  } finally { t.cleanup() }
})

test('SP3 不存在的会话 → missing，不误报 purged', { skip: !WIN }, () => {
  const t = makeTmp('prts-sp3-')
  try {
    const root = join(t.dir, 'sessions')
    const probes = probeSessions(root, ['sess-none'])
    assert.equal(probes[0]!.state, 'missing')
    const r = purgeSessions({ sessionsRoot: root, sessionIds: ['sess-none'] })
    assert.deepEqual(r.missing, ['sess-none'])
    assert.equal(r.purged.length, 0)
  } finally { t.cleanup() }
})

test('SP4 purge 后 K4 挂着的 session-log derivative 补 done，全完成自动 completed', { skip: !WIN }, () => {
  const t = makeTmp('prts-sp4-')
  try {
    const root = join(t.dir, 'sessions')
    makeSessionDir(root, '--ws--', 'sess-k4')
    const au = AuditLog.open(join(t.dir, 'core.sqlite'))
    try {
      au.append({ kind: 'owner' }, {
        kind: 'deletion.requested', deletionId: 'k4del-x',
        target: { kind: 'memory-turn', id: 'turn-1' },
        derivatives: [
          { kind: 'memory-store', ref: 'memory.sqlite' },
          { kind: 'session-log', ref: 'sess-k4' },
        ],
      })
      au.append({ kind: 'owner' }, { kind: 'deletion.derivative-done', deletionId: 'k4del-x', index: 0 })
      assert.equal(au.deletion('k4del-x').completed, false, 'session-log 未完时 deletion 保持未完成')

      const r = purgeSessions({ sessionsRoot: root, sessionIds: ['sess-k4'], audit: au })
      assert.deepEqual(r.purged, ['sess-k4'])
      assert.equal(r.k4Marked, 1, '应补一条 derivative-done')
      assert.deepEqual(r.k4Completed, ['k4del-x'], '最后一个 derivative 完成 → deletion 自动 completed')
      assert.equal(au.deletion('k4del-x').completed, true)
    } finally { au.close() }
  } finally { t.cleanup() }
})

test('SP5 端到端：真实运行时的活动会话必须 busy；dispose 后可删（锁协议互操作契约）', { skip: !WIN, timeout: 120000 }, async () => {
  const t = makeTmp('prts-sp5-')
  const dataRoot = join(t.dir, 'data')
  const workspace = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    app = await startRuntime({ configPath: prtsYml, dataRoot, workspace, mode: 'normal', patches: disableLlm })
    scriptedLlmPlugin([{ type: 'text', text: '收到。' } as ScriptedStep]).apply(app.ctx as Context)
    await runTurn(app.ctx as Context, '会话锁契约探针', { cwd: workspace })

    const sessionsRoot = join(dataRoot, 'dsh-home', 'sessions')
    // 会话物化是写路径的延迟动作，轮询等 jsonl 出现（V1-06 实测产物形态）。
    let live: { id: string; dir: string } | undefined
    for (let i = 0; i < 30 && live === undefined; i++) {
      live = anySessionDir(sessionsRoot)
      if (live === undefined) await new Promise(r => setTimeout(r, 100))
    }
    assert.ok(live, '跑过一轮后必须存在会话目录')

    const probes = probeSessions(sessionsRoot, [live.id])
    assert.equal(probes[0]!.state, 'busy',
      '活动运行时持有的会话必须探测为 busy——若为 free 说明锁协议与上游脱钩，整条路径不可信')

    const r = purgeSessions({ sessionsRoot, sessionIds: [live.id] })
    assert.equal(r.purged.length, 0, '活动会话不许被删')
    assert.ok(existsSync(join(live.dir, 'session.v4.jsonl')), '会话日志必须完好')

    await app.dispose()
    app = undefined

    const probes2 = probeSessions(sessionsRoot, [live.id])
    assert.equal(probes2[0]!.state, 'free', 'dispose 释放租约后应转为 free')
    const r2 = purgeSessions({ sessionsRoot, sessionIds: [live.id] })
    assert.deepEqual(r2.purged, [live.id])
    assert.equal(existsSync(live.dir), false)
  } finally {
    await app?.dispose()
    t.cleanup()
  }
})
