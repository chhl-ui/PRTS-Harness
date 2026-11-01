import test from 'node:test'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createLocalSpillStore } from '../../src/spill/store.ts'
import { makeTmp } from '../support/tmp.ts'

const sessionHash = (sessionId: string): string =>
  createHash('sha256').update(sessionId).digest('hex').slice(0, 16)

function root(): { dir: string; root: string; cleanup(...c: { close(): void }[]): void } {
  const t = makeTmp('prts-spill-')
  return { dir: t.dir, root: join(t.dir, 'spill'), cleanup: t.cleanup }
}

test('单行结果的 retrievalHint 给出 pwsh 分段读命令（read 会按 2000 字符截断单行）', async () => {
  const t = root()
  try {
    const store = createLocalSpillStore({ root: t.root })
    const ref = await store.saveText({
      sessionId: 's1', toolName: 'pwsh', callId: 'c1', suggestedName: 'one-line.txt', content: 'x'.repeat(5000),
    })
    assert.match(ref.retrievalHint, /Substring/i, '单行结果应给出 PowerShell 的 Substring 分段读法')
    assert.equal(ref.retrievalHint.includes(ref.locator), true)
  } finally { t.cleanup() }
})

test('多行结果的 retrievalHint 指向 read 的 offset 续读', async () => {
  const t = root()
  try {
    const store = createLocalSpillStore({ root: t.root })
    const ref = await store.saveText({
      sessionId: 's1', toolName: 'pwsh', callId: 'c1', suggestedName: 'multi.txt', content: 'a\nb\nc',
    })
    assert.match(ref.retrievalHint, /offset/i, '多行结果应指向 read 的 offset 续读')
  } finally { t.cleanup() }
})

test('写入后文件存在且内容逐字等于输入，bytes 按 UTF-8 计', async () => {
  const t = root()
  try {
    const store = createLocalSpillStore({ root: t.root })
    const content = '中文与 emoji 😀 混排的一段工具输出\n第二行'
    const ref = await store.saveText({
      sessionId: 's1', toolName: 'pwsh', callId: 'c1', suggestedName: 'pwsh.txt', content,
    })
    assert.equal(existsSync(ref.locator), true)
    assert.equal(readFileSync(ref.locator, 'utf8'), content)
    assert.equal(ref.bytes, Buffer.byteLength(content, 'utf8'))
    assert.equal(ref.retrievalHint.includes(ref.locator), true)
  } finally { t.cleanup() }
})

test('不同 sessionId 落在不同会话目录，目录名是 sha256 前 16 位', async () => {
  const t = root()
  try {
    const store = createLocalSpillStore({ root: t.root })
    const a = await store.saveText({ sessionId: 's1', toolName: 't', callId: 'c1', suggestedName: 'a.txt', content: 'x' })
    const b = await store.saveText({ sessionId: 's2', toolName: 't', callId: 'c2', suggestedName: 'a.txt', content: 'x' })
    assert.equal(a.locator.includes(join(t.root, `session-${sessionHash('s1')}`)), true)
    assert.equal(b.locator.includes(join(t.root, `session-${sessionHash('s2')}`)), true)
    assert.notEqual(a.locator, b.locator)
  } finally { t.cleanup() }
})

test('同名 suggestedName 两次写入不覆盖（随机前缀不同）', async () => {
  const t = root()
  try {
    const store = createLocalSpillStore({ root: t.root })
    const a = await store.saveText({ sessionId: 's1', toolName: 't', callId: 'c1', suggestedName: 'same.txt', content: 'first' })
    const b = await store.saveText({ sessionId: 's1', toolName: 't', callId: 'c2', suggestedName: 'same.txt', content: 'second' })
    assert.notEqual(a.locator, b.locator)
    assert.equal(readFileSync(a.locator, 'utf8'), 'first')
    assert.equal(readFileSync(b.locator, 'utf8'), 'second')
  } finally { t.cleanup() }
})

test('根不存在时自动创建', async () => {
  const t = root()
  try {
    assert.equal(existsSync(t.root), false)
    const store = createLocalSpillStore({ root: t.root })
    await store.saveText({ sessionId: 's1', toolName: 't', callId: 'c1', suggestedName: 'a.txt', content: 'x' })
    assert.equal(existsSync(t.root), true)
  } finally { t.cleanup() }
})

test('suggestedName 里的穿越尝试落到单一级文件名，不会跳出会话目录', async () => {
  const t = root()
  try {
    const store = createLocalSpillStore({ root: t.root })
    const ref = await store.saveText({
      sessionId: 's1', toolName: 't', callId: 'c1', suggestedName: '../../../escape.txt', content: 'x',
    })
    const dir = join(t.root, `session-${sessionHash('s1')}`)
    assert.equal(ref.locator.startsWith(dir), true)
    assert.equal(readdirSync(dir).length, 1)
    assert.equal(existsSync(join(t.root, 'escape.txt')), false)
  } finally { t.cleanup() }
})

test('会话目录被换成符号链接/文件时拒绝写入（不跟随）', async () => {
  const t = root()
  try {
    const dir = join(t.root, `session-${sessionHash('s1')}`)
    await mkdir(t.root, { recursive: true })
    // 用普通文件占位，模拟「该路径已不是目录」；实现必须拒绝而不是写进去。
    await writeFile(dir, 'not a directory')
    const store = createLocalSpillStore({ root: t.root })
    await assert.rejects(() => store.saveText({
      sessionId: 's1', toolName: 't', callId: 'c1', suggestedName: 'a.txt', content: 'x',
    }))
  } finally { t.cleanup() }
})
