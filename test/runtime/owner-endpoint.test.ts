/**
 * 端点探活：`terminal.endpoint` 里记的 pid 还在不在。
 *
 * 为什么需要它：`chat-serve.ts` 的 finally 会删端点，但进程被强杀或崩溃时
 * finally 不执行，端点就残留成陷阱——客户端读到它只会得到 `connect ENOENT`，
 * 完全看不出「服务已经没了、该重启的是 serve」（2026-11-06 实测：端点指向
 * pid 20884，进程早已退出，桌面端 smoke 一直连不上）。
 *
 * 探活只用于**诊断提示**，不改变连接语义：真连上了照样用，探活失败也照样重试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeEndpointOwner, OWNER_ENDPOINT_FILE } from '../../src/runtime/owner-protocol.ts'
import { makeTmp } from '../support/tmp.ts'

function seed(dataRoot: string, pid: number): void {
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(
    join(dataRoot, OWNER_ENDPOINT_FILE),
    JSON.stringify({ pipe: '\\\\.\\pipe\\prts-term-test', pid, startedAt: Date.now() }),
    'utf8',
  )
}

test('EP1 端点指向活进程：alive=true', () => {
  const t = makeTmp('prts-ep-1-')
  try {
    const dataRoot = join(t.dir, 'data')
    seed(dataRoot, process.pid)
    const r = probeEndpointOwner(dataRoot)
    assert.equal(r?.pid, process.pid)
    assert.equal(r?.alive, true)
  } finally { t.cleanup() }
})

test('EP2 端点指向已退出的 pid：alive=false（陈旧端点的可诊断信号）', () => {
  const t = makeTmp('prts-ep-2-')
  try {
    const dataRoot = join(t.dir, 'data')
    // 999999 超出常见 pid 上限，Windows 上必然不存在
    seed(dataRoot, 999999)
    const r = probeEndpointOwner(dataRoot)
    assert.equal(r?.pid, 999999)
    assert.equal(r?.alive, false)
  } finally { t.cleanup() }
})

test('EP3 没有端点文件 / 文件损坏：返回 undefined（不抛）', () => {
  const t = makeTmp('prts-ep-3-')
  try {
    const missing = join(t.dir, 'nope')
    assert.equal(probeEndpointOwner(missing), undefined, '没有端点时不该抛')

    const broken = join(t.dir, 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, OWNER_ENDPOINT_FILE), '{not json', 'utf8')
    assert.equal(probeEndpointOwner(broken), undefined, '坏 JSON 时不该抛')

    const noPid = join(t.dir, 'nopid')
    mkdirSync(noPid, { recursive: true })
    writeFileSync(join(noPid, OWNER_ENDPOINT_FILE), JSON.stringify({ pipe: 'x' }), 'utf8')
    assert.equal(probeEndpointOwner(noPid), undefined, '缺 pid 字段时不该抛')
  } finally { t.cleanup() }
})
