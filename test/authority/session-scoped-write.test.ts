/**
 * 会话级写入口径（W2）：`decideSessionScoped` 接入 fs.write / fs.delete。
 *
 * 铁律是「只收窄、零翻转」：
 * - 已注册的活跃子会话，写自己 roots 之外的工作区文件 → deny；
 * - 未注册会话、主会话、roots 内写入 → 与改动前完全一致（allow via policy）；
 * - fs.read 不经过这条口径，子会话读工作区仍 allow。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { Authority } from '../../src/authority/authority.ts'
import { cap } from '../../src/authority/capability.ts'
import { makeTmp } from '../support/tmp.ts'

interface Ctx {
  a: Authority
  ws: string
  subRoot: string
  cleanup: () => void
}

function withScopedAuth(fn: (ctx: Ctx) => void): void {
  const t = makeTmp('prts-session-scoped-')
  const ws = join(t.dir, 'ws')
  const subRoot = join(ws, '.prts-subtask', 't1')
  mkdirSync(subRoot, { recursive: true })
  mkdirSync(join(ws, 'shared'), { recursive: true })
  const a = Authority.open(t.db('core.sqlite'), { workspaceRoots: [ws], protectedRoots: [] })
  try {
    a.registerPrimarySession('main-1')
    a.registerSessionRoots('sub-1', [subRoot], 'main-1')
    fn({ a, ws, subRoot, cleanup: () => t.cleanup() })
  } finally {
    a.close()
    t.cleanup()
  }
}

function decide(a: Authority, sessionId: string, tool: string, capability: string) {
  return a.decide({
    sessionId,
    callId: `call-${sessionId}-${tool}-${capability.length}`,
    tool,
    capabilities: [capability as never],
  })
}

test('W1 子会话写自己 roots 内 → allow via policy', () => {
  withScopedAuth(({ a, subRoot }) => {
    const target = join(subRoot, 'note.txt')
    const d = decide(a, 'sub-1', 'write', cap.fsWrite(target))
    assert.equal(d.kind, 'allow')
    assert.equal(d.kind === 'allow' ? d.via : undefined, 'policy')
  })
})

test('W2 子会话写全局 workspace 内、roots 外 → deny，理由含 subagent session', () => {
  withScopedAuth(({ a, ws }) => {
    const target = join(ws, 'shared', 'evil.txt')
    const d = decide(a, 'sub-1', 'write', cap.fsWrite(target))
    assert.equal(d.kind, 'deny')
    assert.match(d.kind === 'deny' ? d.reason : '', /subagent session/)
    assert.equal(typeof a.guard({
      sessionId: 'sub-1', callId: 'c-guard', tool: 'write', capabilities: [cap.fsWrite(target)],
    }), 'string', '守卫必须拒绝并返回理由串')
  })
})

test('W3 子会话删除 roots 外 → deny；roots 内仍 ask', () => {
  withScopedAuth(({ a, ws, subRoot }) => {
    const outside = decide(a, 'sub-1', 'delete', cap.fsDelete(join(ws, 'shared', 'gone.txt')))
    assert.equal(outside.kind, 'deny', '子会话不得删 roots 之外的全局工作区文件')
    assert.match(outside.kind === 'deny' ? outside.reason : '', /subagent session/)

    const inside = decide(a, 'sub-1', 'delete', cap.fsDelete(join(subRoot, 'scratch.txt')))
    assert.equal(inside.kind, 'ask', 'roots 内删除仍是逐次审批，不是 allow')
  })
})

test('W4 主会话写工作区 → 仍 allow via policy（零翻转）', () => {
  withScopedAuth(({ a, ws }) => {
    const d = decide(a, 'main-1', 'write', cap.fsWrite(join(ws, 'shared', 'ok.txt')))
    assert.equal(d.kind, 'allow')
    assert.equal(d.kind === 'allow' ? d.via : undefined, 'policy')
  })
})

test('W5 未注册会话写工作区 → 仍 allow via policy（零翻转）', () => {
  withScopedAuth(({ a, ws }) => {
    const d = decide(a, 'nobody', 'write', cap.fsWrite(join(ws, 'shared', 'ok2.txt')))
    assert.equal(d.kind, 'allow')
    assert.equal(d.kind === 'allow' ? d.via : undefined, 'policy')
  })
})

test('W6 fs.read 不受会话口径影响（子会话读工作区仍 allow）', () => {
  withScopedAuth(({ a, ws }) => {
    const d = decide(a, 'sub-1', 'read', cap.fsRead(join(ws, 'shared', 'any.txt')))
    assert.equal(d.kind, 'allow')
  })
})

test('W7 已释放子会话写工作区 → deny（身份交回后不再持有写权）', () => {
  withScopedAuth(({ a, ws }) => {
    a.releaseSession('sub-1')
    const d = decide(a, 'sub-1', 'write', cap.fsWrite(join(ws, 'shared', 'late.txt')))
    assert.equal(d.kind, 'deny')
  })
})
