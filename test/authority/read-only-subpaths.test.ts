import test from 'node:test'

import assert from 'node:assert/strict'
import { join } from 'node:path'

import { Authority } from '../../src/authority/authority.ts'
import { cap } from '../../src/authority/capability.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Decision } from '../../src/authority/types.ts'

/**
 * workspace 内的只读子路径。
 *
 * 动机（参照 codex 的 `WritableRoot.read_only_subpaths`）：即使整个 workspace 可写，
 * 也不能让模型改自己的元数据——`.git` 被改可以伪造提交历史，`.prts` 之类可以藏状态。
 * 范围限定在 workspace 内部，不影响 workspace 之外既有的 ask/grant 语义。
 */

function fixture(readOnlySubpaths?: string[]) {
  const t = makeTmp('prts-ro-sub-')
  const workspace = join(t.dir, 'ws')
  const dataRoot = join(t.dir, 'data')
  const authority = Authority.open(t.db('core.sqlite'), {
    workspaceRoots: [workspace],
    protectedRoots: [dataRoot],
    ...(readOnlySubpaths === undefined ? {} : { readOnlySubpaths }),
  })
  return { authority, workspace, t, cleanup: () => t.cleanup(authority) }
}

function decide(authority: Authority, c: string): Decision {
  return authority.decide({ sessionId: 's1', callId: `c-${Math.random()}`, tool: 't', capabilities: [c] })
}

test('默认：workspace 内 .git 下的写入被 deny，理由指明只读子路径', () => {
  const f = fixture()
  try {
    const d = decide(f.authority, cap.fsWrite(join(f.workspace, '.git', 'config')))
    assert.equal(d.kind, 'deny')
    assert.match((d as { reason: string }).reason, /read-only subpath/)
  } finally { f.cleanup() }
})

test('默认：.git 的删除同样被 deny', () => {
  const f = fixture()
  try {
    const d = decide(f.authority, cap.fsDelete(join(f.workspace, '.git', 'HEAD')))
    assert.equal(d.kind, 'deny')
    assert.match((d as { reason: string }).reason, /read-only subpath/)
  } finally { f.cleanup() }
})

test('默认：.git 的读取不受影响（只限制写与删）', () => {
  const f = fixture()
  try {
    assert.equal(decide(f.authority, cap.fsRead(join(f.workspace, '.git', 'config'))).kind, 'allow')
  } finally { f.cleanup() }
})

test('workspace 内的普通路径写仍 allow', () => {
  const f = fixture()
  try {
    assert.equal(decide(f.authority, cap.fsWrite(join(f.workspace, 'a.txt'))).kind, 'allow')
    assert.equal(decide(f.authority, cap.fsWrite(join(f.workspace, 'src', 'x.ts'))).kind, 'allow')
  } finally { f.cleanup() }
})

test('名字相近但不是只读子路径的目录不受影响（.github 不等于 .git）', () => {
  const f = fixture()
  try {
    assert.equal(decide(f.authority, cap.fsWrite(join(f.workspace, '.github', 'ci.yml'))).kind, 'allow')
    assert.equal(decide(f.authority, cap.fsWrite(join(f.workspace, 'notgit', 'x'))).kind, 'allow')
  } finally { f.cleanup() }
})

test('可配置：传入自定义子路径时生效，默认可被替换', () => {
  const f = fixture(['.prts', 'vendor'])
  try {
    assert.equal(decide(f.authority, cap.fsWrite(join(f.workspace, '.prts', 'state.db'))).kind, 'deny')
    assert.equal(decide(f.authority, cap.fsWrite(join(f.workspace, 'vendor', 'lib.js'))).kind, 'deny')
  } finally { f.cleanup() }
})

test('传空数组即关闭该功能（workspace 内全部可写）', () => {
  const f = fixture([])
  try {
    assert.equal(decide(f.authority, cap.fsWrite(join(f.workspace, '.git', 'config'))).kind, 'allow')
  } finally { f.cleanup() }
})

test('只读子路径判定不影响 workspace 之外的既有语义（仍为 ask）', () => {
  const f = fixture()
  try {
    assert.equal(decide(f.authority, cap.fsWrite(join(f.t.dir, 'outside', 'x'))).kind, 'ask')
  } finally { f.cleanup() }
})
