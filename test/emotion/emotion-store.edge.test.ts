/**
 * 情感模块的**边界与失败路径**行为测试（V1-05 的补充面）。
 *
 * `test/emotion/emotion-store.test.ts` 是验收合同，钉的是主路径：
 * 持久化、衰减、事实隔离、链校验。本文件补的是同一批需求的**反例**：
 *
 * - 非法输入（空、越界、非有限数、数字字符串、空白标签）必须 INVALID_INPUT，
 *   且被拒之后链上一个字节都不该多出来——「拒绝了但悄悄写了一条」是最坏形态，
 *   它让取证面记下一次从未生效的修改。
 * - actor 的四种坏形状（null / model / 无 component 的 system / 空 component）
 *   全部 FORBIDDEN，状态与 revision 不变。
 * - 时间参数（atMs / nowMs / halfLifeMs）非有限或负数一律拒；时钟回拨不放大情绪。
 * - 特殊键名（`__proto__` / `constructor` / `toString`）当标签用时只是普通字符串，
 *   不能被任何「已知值」查表误判。
 * - 投影被绕过 store 改动/删除时：`rebuildProjections` 还原链上的真相，
 *   而不是让投影的谎话留下来；链非空而投影缺失时 update 指路而不是写出坏事件。
 * - fold 是唯一写投影的入口：未知 kind、坏载荷、revision 跳跃都必须当场炸。
 *
 * 与验收合同同目录（`test/emotion/`），这样 `node --test "test/**\/*.test.ts"`
 * 会收集到它。初版被放在 `src/` 下——那会让它不被任何测试命令跑到，
 * 等于一份没人执行的断言；tsc 只能证明类型对，证明不了行为对。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EmotionStore, applyEmotionEvent, openEmotionDb } from '../../src/emotion/index.ts'
import type { EmotionActor, EmotionState } from '../../src/emotion/index.ts'

const owner: EmotionActor = { kind: 'owner' }
const system: EmotionActor = { kind: 'system', component: 'task' }

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE'
  }
  return assert.fail('expected throw, got none') as never
}

interface Sink {
  store: EmotionStore
  dbPath: string
  dir: string
  done(...extra: { close(): void }[]): void
}

function open(prefix = 'prts-emotion-edge-'): Sink {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const dbPath = join(dir, 'emotion.sqlite')
  const store = EmotionStore.open(dbPath)
  return {
    store,
    dbPath,
    dir,
    done(...extra) {
      try { store.close() } catch { /* 已关闭则忽略 */ }
      for (const c of extra) {
        try { c.close() } catch { /* 已关闭则忽略 */ }
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}

const HALF = 3 * 3_600_000
const T0 = 1_700_000_000_000

/** 一条合法基线，各测试在此基础上改一个字段。 */
function base(): { valence: number; arousal: number; label: string; reason: string; atMs: number } {
  return { valence: 0.4, arousal: 0.3, label: '平静', reason: '基线', atMs: T0 }
}

// ---------- 输入边界：空、零、越界、非有限数、类型 ----------

test('ED1 空输入与缺字段一律 INVALID_INPUT，且不写链', () => {
  const c = open()
  try {
    assert.equal(codeOf(() => c.store.update(owner, undefined as never)), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.update(owner, {} as never)), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.update(owner, null as never)), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.update(owner, { ...base(), label: undefined } as never)), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.update(owner, { ...base(), reason: '' } as never)), 'INVALID_INPUT')
    assert.equal(c.store.get(), undefined, '被拒的输入不得留下投影')
    assert.deepEqual(c.store.verifyChain(), { ok: true, events: 0 }, '被拒的输入不得留下事件')
  } finally { c.done() }
})

test('ED2 区间端点合法：valence ±1、arousal 0 与 1、零值都写成功', () => {
  const c = open()
  try {
    let s: EmotionState = c.store.update(owner, { valence: 1, arousal: 1, label: 'a', reason: 'r', atMs: T0 })
    assert.equal(s.revision, 1)
    s = c.store.update(owner, { valence: -1, arousal: 0, label: 'b', reason: 'r', atMs: T0 })
    assert.equal(s.revision, 2)
    s = c.store.update(owner, { valence: 0, arousal: 0, label: 'c', reason: 'r', atMs: T0 })
    assert.equal(s.valence, 0)
    assert.equal(s.arousal, 0)
    assert.equal(s.revision, 3)
    // -0 也是 0：不能因为 `-0 < 0` 为 false 就被判越界，也不能被存成非零。
    s = c.store.update(owner, { valence: -0, arousal: -0, label: 'd', reason: 'r', atMs: T0 })
    assert.equal(Math.abs(s.valence), 0)
    assert.equal(Math.abs(s.arousal), 0)
    assert.deepEqual(c.store.verifyChain(), { ok: true, events: 4 })
  } finally { c.done() }
})

test('ED3 越界与非有限数被拒：NaN / ±Infinity / 数字字符串 / 越界一点', () => {
  const c = open()
  try {
    const bad: unknown[] = [
      Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      '0.5', 1.0001, -1.0001, true, null,
    ]
    for (const v of bad) {
      assert.equal(codeOf(() => c.store.update(owner, { ...base(), valence: v as never })), 'INVALID_INPUT',
        `valence=${String(v)} 应被拒`)
      assert.equal(codeOf(() => c.store.update(owner, { ...base(), arousal: v as never })), 'INVALID_INPUT',
        `arousal=${String(v)} 应被拒`)
    }
    assert.equal(codeOf(() => c.store.update(owner, { ...base(), arousal: 1.0001 })), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.update(owner, { ...base(), arousal: -0.0001 })), 'INVALID_INPUT')
    assert.equal(c.store.get(), undefined)
    assert.deepEqual(c.store.verifyChain(), { ok: true, events: 0 })
  } finally { c.done() }
})

test('ED4 空白标签与空白理由被拒；全角空格也算空白', () => {
  const c = open()
  try {
    for (const blank of ['', ' ', '   ', '\t', '\n', '\u3000', ' \u3000\t\n ']) {
      assert.equal(codeOf(() => c.store.update(owner, { ...base(), label: blank })), 'INVALID_INPUT',
        `label=${JSON.stringify(blank)} 应被拒`)
      assert.equal(codeOf(() => c.store.update(owner, { ...base(), reason: blank })), 'INVALID_INPUT',
        `reason=${JSON.stringify(blank)} 应被拒`)
    }
    assert.equal(codeOf(() => c.store.update(owner, { ...base(), label: 42 as never })), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.update(owner, { ...base(), reason: {} as never })), 'INVALID_INPUT')
    assert.equal(c.store.get(), undefined)
  } finally { c.done() }
})

test('ED5 原型链键名当标签/理由时是普通字符串，不是「已知值」', () => {
  const c = open()
  try {
    const s = c.store.update(owner, { valence: 0.2, arousal: 0.2, label: '__proto__', reason: 'constructor' })
    assert.equal(s.label, '__proto__')
    assert.ok(c.store.renderMood(T0).includes('__proto__'))
    c.store.update(owner, { valence: 0.2, arousal: 0.2, label: 'constructor', reason: 'toString' })
    assert.equal(c.store.get()?.label, 'constructor')
    // 顺着原型链「查表」的实现会把这些名字当成函数或 undefined；这里必须原样往返。
    c.store.close()
    const again = EmotionStore.open(c.dbPath)
    try {
      assert.equal(again.get()?.label, 'constructor')
    } finally { again.close() }
  } finally { c.done() }
})

// ---------- 权限边界 ----------

test('ED6 四种坏 actor 全部 FORBIDDEN，状态与链一个字节都不变', () => {
  const c = open()
  try {
    c.store.update(owner, { ...base(), label: '基线' })
    const before = c.store.get()
    const chainBefore = c.store.verifyChain()
    const bad: unknown[] = [
      null,
      undefined,
      { kind: 'model', sessionId: 's' },
      { kind: 'system' },
      { kind: 'system', component: '   ' },
      { kind: 'system', component: 7 },
      { kind: 'Owner' },
      { kind: 'owner', extra: true, kind2: 'owner' },
    ]
    for (const actor of bad) {
      // 最后一项 `{kind:'owner',...}` 是合法的（kind 对了就是 owner），单独处理：
      if ((actor as { kind?: string })?.kind === 'owner') continue
      assert.equal(codeOf(() => c.store.update(actor as never, { ...base(), label: '被篡改' })), 'FORBIDDEN',
        `actor=${JSON.stringify(actor)} 应被拒`)
    }
    assert.deepEqual(c.store.get(), before, '被拒后投影不得改变')
    assert.deepEqual(c.store.verifyChain(), chainBefore, '被拒后链不得增长')
  } finally { c.done() }
})

test('ED7 system 必须带 component；带上后可以写', () => {
  const c = open()
  try {
    const s = c.store.update(system, { ...base(), label: '低落' })
    assert.equal(s.label, '低落')
    assert.equal(s.revision, 1)
  } finally { c.done() }
})

// ---------- 时间参数边界 ----------

test('ED8 atMs / nowMs 非有限或负数被拒；省略 atMs 时用当前时钟', () => {
  const c = open()
  try {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '1700000000000', null]) {
      assert.equal(codeOf(() => c.store.update(owner, { ...base(), atMs: bad as never })), 'INVALID_INPUT',
        `atMs=${String(bad)} 应被拒`)
    }
    const before = Date.now()
    const s = c.store.update(owner, { valence: 0.1, arousal: 0.1, label: '中性', reason: '省略 atMs' })
    const after = Date.now()
    assert.ok(s.updatedAt >= before && s.updatedAt <= after, `updatedAt 应落在写入区间内，实得 ${s.updatedAt}`)

    assert.equal(codeOf(() => c.store.decay(Number.NaN)), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.decay(-1)), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.renderMood(Number.NaN)), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.renderMood(-1)), 'INVALID_INPUT')
  } finally { c.done() }
})

test('ED9 halfLifeMs 必须是正的有限数；注入后按注入值衰减', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prts-emotion-half-'))
  const dbPath = join(dir, 'emotion.sqlite')
  try {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '3600000', null]) {
      assert.equal(codeOf(() => EmotionStore.open(dbPath, { halfLifeMs: bad as never })), 'INVALID_INPUT',
        `halfLifeMs=${String(bad)} 应被拒`)
    }
    const fast = EmotionStore.open(dbPath, { halfLifeMs: 1000 })
    try {
      const s = fast.update(owner, { valence: 0.8, arousal: 0.8, label: '兴奋', reason: 'r', atMs: T0 })
      assert.equal(s.valence, 0.8)
      const half = fast.decay(T0 + 1000)
      assert.ok(Math.abs(half.valence - 0.4) < 0.02, `注入 1s 半衰期后应剩一半，实得 ${half.valence}`)
      const gone = fast.decay(T0 + 20_000)
      assert.ok(Math.abs(gone.valence) < 1e-4, `20 个半衰期后应接近 0，实得 ${gone.valence}`)
    } finally { fast.close() }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})

test('ED10 衰减只改强度：label / updatedAt / revision 原样；时钟回拨不放大', () => {
  const c = open()
  try {
    const s = c.store.update(owner, { valence: 0.8, arousal: 0.6, label: '兴奋', reason: 'r', atMs: T0 })
    assert.equal(s.revision, 1)
    const d = c.store.decay(T0 + HALF)
    assert.equal(d.label, '兴奋')
    assert.equal(d.updatedAt, T0, 'updatedAt 是衰减零点，不得被衰减改写')
    assert.equal(d.revision, 1)
    assert.ok(Math.abs(d.arousal - 0.3) < 0.02, `arousal 也应衰减一半，实得 ${d.arousal}`)

    // 时钟回拨：不衰减也不放大（否则「时间倒退五分钟」会变成情绪放大器）。
    const back = c.store.decay(T0 - 5 * 60_000)
    assert.equal(back.valence, 0.8)
    assert.equal(back.arousal, 0.6)

    // 同一时刻重复调用幂等，且不写链。
    assert.deepEqual(c.store.decay(T0 + HALF), c.store.decay(T0 + HALF))
    assert.deepEqual(c.store.verifyChain(), { ok: true, events: 1 }, '衰减是纯读，链不得增长')
  } finally { c.done() }
})

test('ED11 空库 decay 抛 NOT_FOUND；renderMood 返回空串（不编默认心情）', () => {
  const c = open()
  try {
    assert.equal(codeOf(() => c.store.decay(T0)), 'NOT_FOUND')
    assert.equal(c.store.renderMood(T0), '')
    assert.equal(c.store.renderMood(), '')
  } finally { c.done() }
})

// ---------- 渲染边界 ----------

test('ED12 renderMood 是单行、有长度硬上限，且只描述情绪', () => {
  const c = open()
  try {
    c.store.update(owner, { valence: -0.6, arousal: 0.7, label: '焦躁\n而且\n分心', reason: 'r', atMs: T0 })
    const mood = c.store.renderMood(T0)
    assert.ok(!mood.includes('\n'), `应是一行：${JSON.stringify(mood)}`)
    assert.ok(mood.includes('焦躁'), `应包含标签：${mood}`)
    assert.ok(mood.length < 120, `长度上限：${mood.length}`)
    // 事实层名词一个都不许出现——情绪只进表达层。
    for (const banned of ['任务', '记忆', '检索', '账本', '技能', '权限', '数据库']) {
      assert.ok(!mood.includes(banned), `渲染不得断言事实（命中 ${banned}）：${mood}`)
    }

    const long = 'x'.repeat(500)
    c.store.update(owner, { valence: 0.3, arousal: 0.2, label: long, reason: 'r', atMs: T0 })
    const truncated = c.store.renderMood(T0)
    assert.ok(truncated.length < 120, `超长标签也必须截到一句话内：${truncated.length}`)
    assert.ok(truncated.includes('x'))
  } finally { c.done() }
})

test('ED13 renderMood 用衰减后的强度说话', () => {
  const c = open()
  try {
    c.store.update(owner, { valence: 0.8, arousal: 0.8, label: '兴奋', reason: 'r', atMs: T0 })
    const fresh = c.store.renderMood(T0)
    assert.ok(fresh.includes('0.80'), `零点应是原强度：${fresh}`)
    const flat = c.store.renderMood(T0 + 10 * HALF)
    assert.ok(flat.includes('0.00'), `十个半衰期后应显示回落到 0：${flat}`)
    assert.ok(flat.includes('兴奋'), '标签不因衰减消失')
  } finally { c.done() }
})

// ---------- 持久化与投影纪律 ----------

test('ED14 reason 进链可查：情绪变化留得住「为什么」', () => {
  const c = open()
  try {
    c.store.update(owner, { ...base(), reason: '连续失败三次' })
    const db = new DatabaseSync(c.dbPath)
    try {
      const rows = db.prepare('SELECT payload_json FROM emotion_events ORDER BY seq').all() as unknown as { payload_json: string }[]
      assert.equal(rows.length, 1)
      const payload = JSON.parse(rows[0].payload_json) as { reason: string; label: string }
      assert.equal(payload.reason, '连续失败三次')
      assert.equal(payload.label, '平静')
    } finally { db.close() }
  } finally { c.done() }
})

test('ED15 情绪库物理隔离：库里只有 emotion_* 两张表', () => {
  const c = open()
  try {
    c.store.update(owner, base())
    const db = new DatabaseSync(c.dbPath)
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[])
        .map((r) => r.name)
      assert.deepEqual(tables.filter((n) => !n.startsWith('emotion_')).sort(), [],
        `情绪库不得混入事实表：${tables.join(',')}`)
      assert.ok(tables.includes('emotion_events') && tables.includes('emotion_state'))
    } finally { db.close() }
  } finally { c.done() }
})

test('ED16 单行投影：第二条 emotion_state 行被结构拒绝', () => {
  const c = open()
  try {
    c.store.update(owner, base())
    const db = new DatabaseSync(c.dbPath)
    try {
      assert.throws(() => db.prepare(
        'INSERT INTO emotion_state (id, revision, valence, arousal, label, updated_at) VALUES (2, 1, 0, 0, ?, 0)',
      ).run('第二行'))
    } finally { db.close() }
    assert.equal(c.store.get()?.label, '平静', '被结构拒掉的写入不影响唯一那行')
  } finally { c.done() }
})

test('ED17 投影被绕过 store 篡改后，rebuildProjections 还原链上的真相', () => {
  const c = open()
  try {
    c.store.update(owner, { ...base(), label: '平静', valence: 0.4 })
    const db = new DatabaseSync(c.dbPath)
    try {
      db.prepare("UPDATE emotion_state SET label = '伪造', valence = -1 WHERE id = 1").run()
    } finally { db.close() }
    assert.equal(c.store.get()?.label, '伪造', '前提：投影被改了')
    c.store.rebuildProjections()
    const restored = c.store.get()
    assert.equal(restored?.label, '平静')
    assert.equal(restored?.valence, 0.4)
    assert.equal(restored?.revision, 1)
    // 重建幂等：链是事实来源，重建多少次都是同一个结果。
    c.store.rebuildProjections()
    assert.deepEqual(c.store.get(), restored)
  } finally { c.done() }
})

test('ED18 投影缺失但链非空时 update 指路 rebuild，且不写出坏事件', () => {
  const c = open()
  try {
    c.store.update(owner, { ...base(), label: 'a' })
    c.store.close()
    const db = new DatabaseSync(c.dbPath)
    try {
      db.prepare('DELETE FROM emotion_state').run()
    } finally { db.close() }
    const again = EmotionStore.open(c.dbPath)
    try {
      const chainBefore = again.verifyChain()
      assert.equal(codeOf(() => again.update(owner, { ...base(), label: 'b' })), 'INVALID_TRANSITION')
      assert.deepEqual(again.verifyChain(), chainBefore, '被拒的写入不得留下事件')
      assert.equal(again.get(), undefined, '投影仍缺失')
      again.rebuildProjections()
      assert.equal(again.get()?.label, 'a', '重建后回到链上的真相')
      // 重建之后写入恢复正常，revision 接着链上的序号走。
      const s = again.update(owner, { ...base(), label: 'b' })
      assert.equal(s.revision, 2)
      assert.deepEqual(again.verifyChain(), { ok: true, events: 2 })
    } finally { again.close() }
  } finally { c.done() }
})

test('ED19 两个连接顺序写：链连续、revision 递增、busy_timeout 兜住写者', () => {
  const c = open()
  const second = EmotionStore.open(c.dbPath)
  try {
    c.store.update(owner, { ...base(), label: 'a' })
    second.update(owner, { ...base(), label: 'b' })
    c.store.update(owner, { ...base(), label: 'c' })
    assert.equal(c.store.get()?.label, 'c')
    assert.equal(second.get()?.label, 'c', '另一个连接立刻看得见（无进程内缓存）')
    assert.deepEqual(c.store.verifyChain(), { ok: true, events: 3 })
    assert.deepEqual(second.verifyChain(), { ok: true, events: 3 })
    assert.equal(c.store.get()?.revision, 3)
  } finally { second.close(); c.done() }
})

test('ED20 重启后强度与标签原样保留（含负值）', () => {
  const c = open()
  try {
    c.store.update(system, { valence: -0.35, arousal: 0.65, label: '警觉', reason: '异常信号', atMs: T0 })
    c.store.close()
    const again = EmotionStore.open(c.dbPath)
    try {
      const s = again.get()
      assert.ok(s !== undefined)
      assert.equal(s.valence, -0.35)
      assert.equal(s.arousal, 0.65)
      assert.equal(s.label, '警觉')
      assert.equal(s.updatedAt, T0)
      assert.equal(s.revision, 1)
    } finally { again.close() }
  } finally { c.done() }
})

// ---------- fold：唯一写投影的入口 ----------

test('ED21 未知事件种类必须当场炸，不许静默漏一条', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prts-emotion-fold-'))
  const dbPath = join(dir, 'emotion.sqlite')
  const db = openEmotionDb(dbPath)
  try {
    assert.equal(codeOf(() => applyEmotionEvent(db, {
      revision: 1, kind: 'emotion.deleted', actor: owner, payload: {}, ts: T0,
    })), 'INVALID_INPUT')
    assert.equal(codeOf(() => applyEmotionEvent(db, {
      revision: 1, kind: '', actor: owner, payload: {}, ts: T0,
    })), 'INVALID_INPUT')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('ED22 fold 守住范围与形状：越界数值、坏载荷、revision 跳跃都拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prts-emotion-fold2-'))
  const dbPath = join(dir, 'emotion.sqlite')
  const db = openEmotionDb(dbPath)
  try {
    const ok = { valence: 0.2, arousal: 0.2, label: '平静' }
    assert.equal(codeOf(() => applyEmotionEvent(db, {
      revision: 1, kind: 'emotion.updated', actor: owner, payload: { ...ok, valence: 1.2 }, ts: T0,
    })), 'INVALID_INPUT')
    assert.equal(codeOf(() => applyEmotionEvent(db, {
      revision: 1, kind: 'emotion.updated', actor: owner, payload: { ...ok, arousal: Number.NaN }, ts: T0,
    })), 'INVALID_INPUT')
    assert.equal(codeOf(() => applyEmotionEvent(db, {
      revision: 1, kind: 'emotion.updated', actor: owner, payload: { ...ok, label: 9 }, ts: T0,
    })), 'INVALID_INPUT')
    assert.equal(codeOf(() => applyEmotionEvent(db, {
      revision: 1, kind: 'emotion.updated', actor: owner, payload: [], ts: T0,
    })), 'INVALID_INPUT')
    // 空投影上的第一条事件必须是 revision 1。
    assert.equal(codeOf(() => applyEmotionEvent(db, {
      revision: 2, kind: 'emotion.updated', actor: owner, payload: ok, ts: T0,
    })), 'INVALID_TRANSITION')

    applyEmotionEvent(db, { revision: 1, kind: 'emotion.updated', actor: owner, payload: ok, ts: T0 })
    // 跳跃 / 倒退 / 重复都必须炸：允许它们等于允许把两次修改压成一次。
    for (const revision of [1, 3, 0, -1]) {
      assert.equal(codeOf(() => applyEmotionEvent(db, {
        revision, kind: 'emotion.updated', actor: owner, payload: ok, ts: T0,
      })), 'INVALID_TRANSITION', `revision=${revision} 应被拒`)
    }
    applyEmotionEvent(db, { revision: 2, kind: 'emotion.updated', actor: owner, payload: { ...ok, label: '专注' }, ts: T0 + 1 })
    const row = db.prepare('SELECT revision, label FROM emotion_state WHERE id = 1').get() as { revision: number; label: string }
    assert.equal(row.revision, 2)
    assert.equal(row.label, '专注')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
