/**
 * V1-09 验收取证：架构需求 §7 原文两句话，一条测试逐句对上。
 *
 * > 至少完成 1 次「经验 → 候选 → 评估 → 采用」流程，并完成 1 次回退演练；
 * > 人格核心设定未经确认不能被改动。
 *
 * 前两半在本文件；第三半（人格核心设定）不在本模块的职责里——人格模块尚未落地，
 * 这里如实标注为**未覆盖**，不假装有。
 *
 * 为什么单独写而不是靠 SK1–SK15：那些是分段的不变量。验收问的是
 * 「走完一整圈之后系统是什么样」——中间步骤都对、串起来不对，是完全可能的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { SkillStore } from '../../src/skills/index.ts'
import { makeTmp } from '../support/tmp.ts'

const owner = { kind: 'owner' as const }

test('V1-09 ①「经验 → 候选 → 评估 → 采用」走完整一圈', () => {
  const tmp = makeTmp('prts-v109-')
  const store = SkillStore.open(join(tmp.dir, 'skills.sqlite'))
  try {
    // 经验：这一轮踩过坑之后总结出来的做法
    const experience = {
      title: '改共享模块前先 grep 全部消费方',
      trigger: '要改一个被多处 import 的函数签名时',
      steps: ['grep 该符号的所有引用', '逐个确认签名同步', '再跑全量'],
      pitfalls: ['只看当前文件的调用会漏掉跨包消费方，类型检查也未必覆盖'],
      sourceRefs: ['turn-82', '69d9219'],
    }
    const id = store.propose({ kind: 'model', sessionId: 'sess-1' }, experience)
    assert.equal(store.get(id)?.phase, 'candidate', '第一步：经验落成候选')

    // 评估：博士看过，给了依据
    const evaluated = store.evaluate(owner, { id, revision: 1 }, {
      verdict: 'adopt',
      basis: '上一个任务就是漏了跨包消费方，这条能挡住同类问题',
    })
    assert.equal(evaluated.phase, 'candidate', '第二步：评估只记录，不代替采用')

    // 采用
    const adopted = store.adopt(owner, { id, revision: evaluated.revision })
    assert.equal(adopted.phase, 'active', '第三步：采用之后才生效')
    assert.equal(adopted.evaluations.length, 1)
    assert.equal(store.list({ phase: 'active' }).length, 1)

    // 全圈结束，链条完整
    const v = store.verifyChain()
    assert.equal(v.ok, true)
    if (v.ok) assert.equal(v.events, 3, 'proposed / evaluated / adopted 三条事件')
  } finally { tmp.cleanup(store) }
})

test('V1-09 ② 回退演练：退下来之后不再生效，确认后能演回去', () => {
  const tmp = makeTmp('prts-v109-')
  const store = SkillStore.open(join(tmp.dir, 'skills.sqlite'))
  try {
    const id = store.propose(owner, {
      title: '提交前跑全量', trigger: '准备 commit 时', steps: ['npm test'],
    })
    const e = store.evaluate(owner, { id, revision: 1 }, { verdict: 'adopt', basis: '先试一个任务' })
    const a = store.adopt(owner, { id, revision: e.revision })
    assert.equal(a.phase, 'active')

    // 退下来：必须给理由，否则下次还会被重新提出
    const retired = store.retire(owner, { id, revision: a.revision }, '全量要 40 秒，日常提交不划算')
    assert.equal(retired.phase, 'retired')
    assert.equal(retired.retireReason, '全量要 40 秒，日常提交不划算')
    assert.equal(store.list({ phase: 'active' }).length, 0, '退下来之后不再出现在在用清单里')

    // 演练的另一半：能演回去，否则「回退」就是单向删除，不是可逆操作
    const restored = store.restore(owner, { id, revision: retired.revision }, '演练结束，确认仍然适用')
    assert.equal(restored.phase, 'active')
    assert.equal(restored.retireReason, undefined, '恢复后不应残留退役理由')
    assert.equal(store.list({ phase: 'active' }).length, 1)

    // 全程可审计：5 条事件、链完整
    const v = store.verifyChain()
    assert.equal(v.ok, true)
    if (v.ok) assert.equal(v.events, 5, 'proposed / evaluated / adopted / retired / restored')
  } finally { tmp.cleanup(store) }
})

test('V1-09 ③ 验收原文第三半（人格核心设定未经确认不能改）——本模块未覆盖', () => {
  // 这不是跳过，是如实记账：人格模块尚未落地（`src/` 下没有 persona 层，
  // 人格目前只是 `config/prts.yml:104` 的一段 personaPrefix 字符串）。
  // 技能库只能保证「技能不越权改人格」——它压根没有改人格的通道。
  const tmp = makeTmp('prts-v109-')
  const store = SkillStore.open(join(tmp.dir, 'skills.sqlite'))
  try {
    const names = Object.getOwnPropertyNames(SkillStore.prototype)
    const personaish = names.filter((n) => /persona|core|identity/i.test(n))
    assert.deepEqual(personaish, [], '技能库不应有任何触碰人格设定的方法')
  } finally { tmp.cleanup(store) }
})
