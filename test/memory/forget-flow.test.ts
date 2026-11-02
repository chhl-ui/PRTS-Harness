/** P0-2a 流程层：K4 记账顺序、会话日志扫描、confirm=false 不写任何东西。 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryStore, forgetFlow } from '../../src/memory/index.ts'
import { AuditLog } from '../../src/audit/audit.ts'
import { makeTmp } from '../support/tmp.ts'

const tmps: ReturnType<typeof makeTmp>[] = []
const stores: MemoryStore[] = []
const audits: AuditLog[] = []
after(() => {
  for (const s of stores) { try { s.close() } catch { /* 已关 */ } }
  for (const a of audits) { try { a.close() } catch { /* 已关 */ } }
  for (const t of tmps) t.cleanup()
})
const rig = (sessions = false) => {
  const t = makeTmp('prts-ff-'); tmps.push(t)
  const store = MemoryStore.open(t.db('memory.sqlite')); stores.push(store)
  const audit = AuditLog.open(t.db('core.sqlite')); audits.push(audit)
  const sessionsRoot = join(t.dir, 'dsh-home', 'sessions')
  if (sessions) mkdirSync(sessionsRoot, { recursive: true })
  return { t, store, audit, sessionsRoot }
}

test('FF1 无会话日志：requested + 两条 derivative-done + completed', () => {
  const { store, audit, sessionsRoot } = rig(true)
  const turnId = store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '待删 丹顶鹤7702' })
  const r = forgetFlow({ store, audit, sessionsRoot, ids: [turnId], confirm: true })
  assert.equal(r.ok, true, r.message)
  const events = audit.query()
  const kinds = events.map(e => e.event.kind)
  assert.ok(kinds.includes('deletion.requested'), 'K4 有 requested')
  assert.equal(kinds.filter(k => k === 'deletion.derivative-done').length, 2, '两条 derivative-done（store+compact）')
  assert.equal(kinds.includes('deletion.completed'), true, 'deletion 已收敛 completed')
  assert.equal(store.search({ text: '丹顶鹤7702', limit: 5 }).length, 0)
})

test('FF2 有会话日志：plan 报命中、执行后 session-log 项未完成', () => {
  const { store, audit, sessionsRoot } = rig(true)
  const body = '带引号"和\n换行的正文 金丝猴3306'
  const turnId = store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: body })
  // 假会话日志：DSH 布局 sessions/--cwd--/<sessionId>/session.v4.jsonl，JSON 转义形态
  const sessId = 'fake-session-42'
  mkdirSync(join(sessionsRoot, '--ws--', sessId), { recursive: true })
  writeFileSync(join(sessionsRoot, '--ws--', sessId, 'session.v4.jsonl'),
    JSON.stringify({ type: 'user/message', content: [{ type: 'text', text: body }] }) + '\n')
  const dry = forgetFlow({ store, audit, sessionsRoot, ids: [turnId], confirm: false })
  assert.equal(dry.ok, true)
  assert.equal(dry.sessionHits!.length, 1, `plan 应报出命中会话：${dry.message}`)
  assert.equal(dry.sessionHits![0].sessionId, sessId, 'sessionId 取父目录名而非文件名')
  const r = forgetFlow({ store, audit, sessionsRoot, ids: [turnId], confirm: true })
  assert.equal(r.ok, true)
  assert.ok(r.message.includes('会话日志仍含原文'), `应提示未清：${r.message}`)
  // K4：deletion 未完成（session-log 项没做）
  const events = audit.query()
  const req = events.find(e => e.event.kind === 'deletion.requested')!
  const del = audit.deletion((req.event as { deletionId: string }).deletionId)
  assert.equal(del.completed, false, 'session-log 未完成 → deletion 不收尾')
  const derivs = ((req.event as { derivatives?: { kind: string; ref: string }[] }).derivatives ?? [])
  assert.ok(derivs.some(d => d.kind === 'session-log' && d.ref === sessId), `K4 session-log ref 应为 ${sessId}：${JSON.stringify(derivs)}`)
})

test('FF4 confirm=true 无 audit：拒绝执行、记忆库不动', () => {
  const { store, sessionsRoot } = rig(true)
  const turnId = store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '无审计删除应被拒 孔雀9901' })
  const r = forgetFlow({ store, sessionsRoot, ids: [turnId], confirm: true })
  assert.equal(r.ok, false)
  assert.ok(r.message.includes('audit'), `应说明缺 audit：${r.message}`)
  assert.ok(store.search({ text: '孔雀9901', limit: 5 }).length > 0, '目标不得被删')
})

test('FF5 confirm=false 的计划列出整条原文（所有者盲删防线）', () => {
  const { store, audit, sessionsRoot } = rig(true)
  const turnId = store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '我改喝拿铁了，顺带复述了猫叫墨团和芒果过敏' })
  const r = forgetFlow({ store, audit, sessionsRoot, ids: [turnId], confirm: false })
  assert.equal(r.ok, true)
  assert.ok(r.message.includes(turnId), `计划要带 id：${r.message}`)
  assert.ok(r.message.includes('猫叫墨团'), `计划要带出整条正文，不能只给计数：${r.message}`)
  // 未执行语义不变
  assert.equal(audit.query().length, 0)
})

test('FF3 confirm=false：K4 与记忆库都不写', () => {
  const { store, audit, sessionsRoot } = rig(true)
  const turnId = store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '计划态 孔雀8807' })
  const r = forgetFlow({ store, audit, sessionsRoot, ids: [turnId], confirm: false })
  assert.equal(r.ok, true)
  assert.ok(r.message.includes('未执行'))
  const events = audit.query()
  assert.equal(events.length, 0, 'K4 无写入')
  assert.ok(store.search({ text: '孔雀8807', limit: 5 }).length > 0, 'turn 还在')
})
