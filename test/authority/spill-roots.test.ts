import test from 'node:test'

import assert from 'node:assert/strict'
import { join } from 'node:path'

import { Authority } from '../../src/authority/authority.ts'
import { cap } from '../../src/authority/capability.ts'
import { makeTmp } from '../support/tmp.ts'
import type { AuthorityConfig, Capability, Decision } from '../../src/authority/types.ts'

/**
 * spill 根作为「第三类根」的判定：
 * - `fs.read` 放行（卸载的全部目的就是让模型能回读）
 * - `fs.write` / `fs.delete` 拒绝（模型不得改写自己不该动的事实）
 *
 * 反证说明：spill 根既不在 protectedRoots 也不在 workspaceRoots 里，
 * 所以删掉 spillRoots 这段判定后，write 会落进 grant 检查并返回 `ask`
 * ——T6 断言的是 `deny`，因此会变红。若把 spill 根挪到 protectedRoots 内，
 * 删掉判定后 write 仍被 protectedRoots 拒成 deny，T6 就不再有判别力；
 * 断言 reason 里含 `spill root` 才能区分是哪条规则在做事。
 */

interface Fixture {
  authority: Authority
  spill: string
  workspace: string
  dataRoot: string
  cleanup(): void
}

function fixture(extra: Partial<AuthorityConfig> = {}): Fixture {
  const t = makeTmp('prts-spill-roots-')
  const spill = join(t.dir, 'spill')
  const workspace = join(t.dir, 'ws')
  const dataRoot = join(t.dir, 'data')
  const config: AuthorityConfig = {
    workspaceRoots: [workspace],
    protectedRoots: [dataRoot],
    spillRoots: [spill],
    ...extra,
  }
  const authority = Authority.open(t.db('core.sqlite'), config)
  // 写权限以已注册身份为前提（2026-11-05 翻牌）：fixture 的会话先注册为主会话。
  authority.registerPrimarySession('s1')
  return {
    authority,
    spill,
    workspace,
    dataRoot,
    // Windows 上 sqlite 文件被持有，必须先 close 再删目录，否则 cleanup 抛 EPERM。
    cleanup: () => t.cleanup(authority),
  }
}

function decide(authority: Authority, capability: Capability): Decision {
  return authority.decide({ sessionId: 's1', callId: `c-${Math.random()}`, tool: 't', capabilities: [capability] })
}

test('T5 模型 read spill 根内文件 → allow', () => {
  const f = fixture()
  try {
    const d = decide(f.authority, cap.fsRead(join(f.spill, 'session-abc', 'x.txt')))
    assert.equal(d.kind, 'allow')
  } finally { f.cleanup() }
})

test('T6 模型 write spill 根内文件 → deny，且理由来自 spill 规则', () => {
  const f = fixture()
  try {
    const d = decide(f.authority, cap.fsWrite(join(f.spill, 'session-abc', 'x.txt')))
    assert.equal(d.kind, 'deny')
    assert.match((d as { reason: string }).reason, /spill root/)
  } finally { f.cleanup() }
})

test('T6b 模型 delete spill 根内文件 → deny，且理由来自 spill 规则', () => {
  const f = fixture()
  try {
    const d = decide(f.authority, cap.fsDelete(join(f.spill, 'session-abc', 'x.txt')))
    assert.equal(d.kind, 'deny')
    assert.match((d as { reason: string }).reason, /spill root/)
  } finally { f.cleanup() }
})

test('spill 根本身（非其子路径）同样适用', () => {
  const f = fixture()
  try {
    assert.equal(decide(f.authority, cap.fsRead(f.spill)).kind, 'allow')
    assert.equal(decide(f.authority, cap.fsWrite(f.spill)).kind, 'deny')
  } finally { f.cleanup() }
})

test('名字相近的兄弟目录不受 spill 规则影响', () => {
  const f = fixture()
  try {
    // spill 根是 <tmp>/spill，<tmp>/spill-other 不在其中，应当走普通规则。
    const sibling = `${f.spill}-other/x.txt`
    const d = decide(f.authority, cap.fsWrite(sibling))
    assert.equal(d.kind, 'ask')
  } finally { f.cleanup() }
})

test('回归：protectedRoots 内 read / write 仍一律 deny', () => {
  const f = fixture()
  try {
    const r = decide(f.authority, cap.fsRead(join(f.dataRoot, 'secrets', 'deepseek.key')))
    assert.equal(r.kind, 'deny')
    assert.match((r as { reason: string }).reason, /protected root/)
    const w = decide(f.authority, cap.fsWrite(join(f.dataRoot, 'x')))
    assert.equal(w.kind, 'deny')
    assert.match((w as { reason: string }).reason, /protected root/)
  } finally { f.cleanup() }
})

test('回归：workspaceRoots 内 write 仍 allow', () => {
  const f = fixture()
  try {
    assert.equal(decide(f.authority, cap.fsWrite(join(f.workspace, 'a.txt'))).kind, 'allow')
  } finally { f.cleanup() }
})

test('回归：spillRoots 缺省时行为不变（旧调用方不受影响）', () => {
  const t = makeTmp('prts-spill-none-')
  const authority = Authority.open(t.db('core.sqlite'), {
    workspaceRoots: [join(t.dir, 'ws')],
    protectedRoots: [join(t.dir, 'data')],
  })
  try {
    const d = authority.decide({
      sessionId: 's1', callId: 'c1', tool: 't', capabilities: [cap.fsWrite(join(t.dir, 'elsewhere', 'x'))],
    })
    assert.equal(d.kind, 'ask')
  } finally { t.cleanup(authority) }
})

test('spillRootPaths 返回副本，调用方改不到内部数组', () => {
  const f = fixture()
  try {
    const paths = f.authority.spillRootPaths() as string[]
    assert.equal(paths.length, 1)
    paths.push('C:\\evil')
    assert.equal(f.authority.spillRootPaths().length, 1)
  } finally { f.cleanup() }
})
