/**
 * `mem_facts` 的身份键语义（RED 先行 → 已被一次实测推翻并修正）。
 *
 * 议事会（2026-11-01 五席）指出 `fold.ts` 的 fact 插入是
 * `ON CONFLICT(fact_id) DO NOTHING` 而 `fact_id` 来自 `randomUUID()`——
 * 同一事实反复写入只会不断插新行，`revision` 列硬编码 1 永不递增。
 *
 * **第一版实现把它当成「更新」判定（subject|predicate 相同就退役旧的），
 * 被既有用例 M2 当场证伪**：「博士 偏好 光学镜头设计」与「博士 偏好 光学仪器校准」
 * 的 subject+predicate 完全相同，但它们是两条**并存**的取值，不是谁取代谁。
 *
 * 修正后的语义：身份键是**去重键**（subject|predicate|object 全内容），
 * 只保证「完全相同的事实不重复插入」。「哪条取代哪条」是 `fact.corrected`
 * 的显式职责，不能从字符串推断。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

const countFacts = (path: string): number => {
  const raw = new DatabaseSync(path, { readOnly: true })
  const c = (raw.prepare('SELECT count(*) c FROM mem_facts').get() as { c: number }).c
  raw.close()
  return c
}

test('F1 完全相同的事实重复断言：幂等，库里不产生第二条', () => {
  const t = makeTmp('prts-mem-identity-')
  const path = t.db('memory.sqlite')
  const m = MemoryStore.open(path)
  try {
    const input = {
      actor: 'owner' as const, subject: '博士', predicate: '偏好镜头', object: '50mm 定焦',
      provenance: 'stated' as const, confirmationBasis: 'owner-stated' as const,
    }
    m.assertFact(input)
    m.assertFact(input)
    m.assertFact(input)
    assert.equal(countFacts(path), 1, '同一句事实写三次，库里只能有一条')
  } finally {
    t.cleanup(m)
  }
})

test('F2 同 subject+predicate 但 object 不同：两条并存，谁也不退役谁', () => {
  const t = makeTmp('prts-mem-identity-')
  const path = t.db('memory.sqlite')
  const m = MemoryStore.open(path)
  try {
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好镜头',
      object: '50mm 定焦', provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好镜头',
      object: '85mm 定焦', provenance: 'stated', confirmationBasis: 'owner-stated',
    })

    assert.equal(countFacts(path), 2, '两条并存的偏好，不能互相取代')
    const hits = m.search({ text: '定焦' })
    assert.equal(hits.length, 2, '两条都要能被检索到')
    assert.equal(
      hits.filter((h) => /50mm/.test(h.text)).length, 1,
      '旧值不得被退役——它是并存的另一条偏好',
    )
  } finally {
    t.cleanup(m)
  }
})

test('F3 不同 predicate 不互相影响', () => {
  const t = makeTmp('prts-mem-identity-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好镜头',
      object: '50mm 定焦', provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '在研方向',
      object: '光学设计', provenance: 'stated', confirmationBasis: 'owner-stated',
    })

    const hits = m.search({ text: '定焦 光学设计' })
    assert.equal(hits.length, 2)
  } finally {
    t.cleanup(m)
  }
})
