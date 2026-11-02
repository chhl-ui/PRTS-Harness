/**
 * rerank 接入层。
 *
 * 为什么需要：产品口径实测（`docs/memory-recall-criteria-retest-2026-11-03.md` 第九节）
 * 注入 5 条时 @5 只有 28.8%，交叉编码器重排后到 38.1%（+22 题，McNemar p=0.0000）。
 * 候选池内召回 41.9% 是硬上限，rerank 只重排不新增——它改善的是「池里有但排不进」。
 *
 * 设计纪律：
 * - **fail-open**：reranker 未配置、启动失败、超时、进程崩溃，一律回落到原始顺序，
 *   注入照常发生。记忆检索可以变差，不能因为精排器挂了就不注入。
 * - **纯函数可测**：重排逻辑抽成 `applyRerank`，不依赖进程；进程协议单独测。
 * - **不引入 Node 依赖**：走 Python 子进程（sentence-transformers 生态只有 Python 有），
 *   NDJSON over stdio，不监听端口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyRerank, PythonReranker } from '../../src/memory/rerank.ts'

test('R1 applyRerank 按分数降序重排', () => {
  const hits = [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }, { id: 'c', text: 'z' }]
  const out = applyRerank(hits, [0.1, 0.9, 0.5])
  assert.deepEqual(out.map((h) => h.id), ['b', 'c', 'a'])
})

test('R2 分数相同时保持原顺序（稳定排序，不让同分项互相踩）', () => {
  const hits = [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }, { id: 'c', text: 'z' }]
  assert.deepEqual(applyRerank(hits, [0.5, 0.5, 0.5]).map((h) => h.id), ['a', 'b', 'c'])
})

test('R3 分数与命中数不符时原样返回（fail-open：宁可没重排，不可错排）', () => {
  const hits = [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]
  assert.deepEqual(applyRerank(hits, [0.9]).map((h) => h.id), ['a', 'b'])
  assert.deepEqual(applyRerank(hits, []).map((h) => h.id), ['a', 'b'])
  assert.deepEqual(applyRerank(hits, [0.9, 0.1, 0.5]).map((h) => h.id), ['a', 'b'])
})

test('R4 空命中返回空', () => {
  assert.deepEqual(applyRerank([], []), [])
})

/** 写一个假的 reranker 进程脚本：分数 = 1/(序号+1)，用来验证协议而非模型。 */
function fakeScript(dir: string, body: string): string {
  const p = join(dir, 'fake-rerank.py')
  writeFileSync(p, body, 'utf8')
  return p
}

test('R5 PythonReranker 走 NDJSON over stdio 拿到分数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prts-rr-'))
  const script = fakeScript(dir, `
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    n = len(req["docs"])
    print(json.dumps({"id": req["id"], "scores": [1.0 / (i + 1) for i in range(n)]}), flush=True)
`)
  const r = new PythonReranker({ script, python: 'python', timeoutMs: 30_000 })
  try {
    const scores = await r.score('how tall is the tower', ['doc one', 'doc two', 'doc three'])
    assert.deepEqual(scores, [1, 0.5, 1 / 3])
  } finally {
    r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R6 脚本不存在时 score 抛错（由调用方降级，不静默吞掉故障）', async () => {
  const r = new PythonReranker({ script: 'C:/nonexistent/rerank-server.py', python: 'python', timeoutMs: 10_000 })
  try {
    await assert.rejects(() => r.score('q', ['d']))
  } finally {
    r.close()
  }
})

test('R7 close 后再 score 抛错（避免往已关闭的进程写数据）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prts-rr-'))
  const script = fakeScript(dir, `
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    print(json.dumps({"id": req["id"], "scores": [0.5] * len(req["docs"])}), flush=True)
`)
  const r = new PythonReranker({ script, python: 'python', timeoutMs: 30_000 })
  try {
    assert.deepEqual(await r.score('q', ['d']), [0.5])
    r.close()
    await assert.rejects(() => r.score('q', ['d']))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
