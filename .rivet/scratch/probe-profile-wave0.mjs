/**
 * Wave 0 修正版：验证「模型归纳画像」能否把 preference 类从 40% 基线抬起来。
 *
 * 与原计划的偏离（理由记入执行报告）：
 *   原计划是「人工写画像」。议事会指出两个硬伤：① 人工写画像的作者必然看过 gold，
 *   那就是上界中的上界；② 人工画像不代表自动巩固的能力。所以改成**模型按真实巩固
 *   的形态归纳**——对每个 session 生成画像，不看 gold、不读 is_evidence 标注。
 *
 * 真实性约束（对应未来 Wave 3 的巩固管线）：
 *   - 输入是该题全部 session 的 user turn，不筛证据；
 *   - 每 10 个 session 一批，模型只输出「值得记住的偏好画像」；
 *   - 画像作为 fact 存入（object = 英文自然语言画像），走真实 MemoryStore.search()。
 *   mem_profiles 表要 Wave 1 才建，这里先用 fact 承载，形态等价。
 */
import { readFileSync, rmSync } from 'node:fs'
import { MemoryStore } from 'file:///C:/prts-system/src/memory/index.ts'

const SRC = 'C:/prts-benchmark/longmemeval/longmemeval_s_cleaned.json'
const DB = 'C:/prts-benchmark/profile-probe.sqlite'
const API = 'https://api.deepseek.com/v1/chat/completions'
const key = process.env.DEEPSEEK_API_KEY
const N_Q = Number(process.argv[2] ?? '3')
const SESS_PER_BATCH = 10

for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f) } catch {} }

const PROMPT = `You are consolidating a user's conversation history into durable preference profiles.

Read the sessions below and extract ONLY durable preferences, tastes, constraints, or recurring habits of the user that would help a future assistant personalize its recommendations.

Rules:
- Write each profile as 1-2 ENGLISH sentences, starting with the concrete entity/topic, then the preference and any stated constraint.
- Include stated constraints (times, places, product requirements) inside the sentence.
- Do NOT invent. Only what these sessions support.
- Do NOT restate the user's questions; state what the user prefers.
- If a session contains no durable preference, skip it.

Return only a JSON array: [{"subject":"user","aspect":"short_snake_case_topic","profile":"the 1-2 sentence profile","source_sessions":[session ids]}]
If nothing is extractable, return [].`

async function callModel(prompt) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 1500, response_format: { type: 'json_object' } }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return (await res.json()).choices[0].message.content ?? ''
}

function parseProfiles(raw) {
  let o
  try { o = JSON.parse(raw) } catch { return [] }
  const arr = Array.isArray(o) ? o : (o.profiles ?? o.items ?? [])
  if (!Array.isArray(arr)) return []
  return arr.filter((x) => x && typeof x === 'object' && typeof x.profile === 'string' && x.profile.trim() !== '')
}

async function judge(question, rubric, hits) {
  const facts = hits.length === 0 ? '(none)' : hits.map((h, i) => `${i + 1}. ${h.text}`).join('\n')
  const prompt = `The text labelled "Rubric" describes what a CORRECT ANSWER must contain. It is a grading rubric, NOT an answer to be reproduced.

Given the retrieved memory items, could a responder write an answer that satisfies that rubric?

Rubric: ${rubric}

Retrieved memory:
${facts}

Reply with exactly one word: yes or no.`
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 8 }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return ((await res.json()).choices[0].message.content ?? '').trim().toLowerCase().startsWith('yes')
}

const data = JSON.parse(readFileSync(SRC, 'utf8'))
const items = data.filter((q) => q.question_type === 'single-session-preference').slice(0, N_Q)
const store = MemoryStore.open(DB)

let totalCalls = 0
const results = []

for (const q of items) {
  // 全部 session 的 user turn，不筛证据（真实巩固不知道将来问什么）
  const sessions = (q.haystack_sessions ?? []).map((list, si) => ({
    id: q.haystack_session_ids?.[si] ?? String(si),
    lines: list.filter((t) => t.role === 'user' && typeof t.content === 'string' && t.content.trim() !== '')
      .map((t) => String(t.content).trim().slice(0, 300)),
  })).filter((s) => s.lines.length > 0)

  let profileCount = 0
  for (let i = 0; i < sessions.length; i += SESS_PER_BATCH) {
    const batch = sessions.slice(i, i + SESS_PER_BATCH)
    const body = batch.map((s) => `[${s.id}]\n${s.lines.join('\n')}`).join('\n\n')
    totalCalls++
    let raw
    try { raw = await callModel(`${PROMPT}\n\nSessions:\n${body}`) } catch (e) { console.error('  consolidate failed:', e.message); continue }
    for (const p of parseProfiles(raw)) {
      try {
        store.assertFact({
          actor: 'model',
          subject: String(p.subject ?? 'user').slice(0, 60),
          predicate: String(p.aspect ?? 'preference_profile').slice(0, 60),
          object: String(p.profile).slice(0, 600),
          provenance: 'inferred',
          confirmationBasis: 'model-inferred',
          origin: 'benchmark',
          importance: 0.9,
        })
        profileCount++
      } catch { /* 单条失败不中断 */ }
    }
  }

  // 真实检索路径
  const hits = store.search({ text: q.question, includeOrigin: ['benchmark'], limit: 8 })
  const profileHits = hits.filter((h) => h.kind === 'fact')
  totalCalls++
  const ok = await judge(q.question, String(q.answer ?? ''), hits)
  results.push({ qid: q.question_id, question: q.question, profileCount, hitCount: profileHits.length, ok })
  console.log(`  [${results.length}/${items.length}] ${profileCount} 条画像 | top-8 含 fact ${profileHits.length} 条 | ${ok ? 'YES' : 'no'}`)
}
store.close()

const yes = results.filter((r) => r.ok).length
console.log(`\n=== Wave 0 结果 ===`)
console.log(`  ${yes}/${results.length} 可回答（rubric 判据），调用 ${totalCalls} 次`)
console.log(`  对照基线：抽取+检索 4/10 = 40%（同一判据）`)
for (const r of results) console.log(`    ${r.ok ? 'YES' : 'no '} 画像 ${r.profileCount} 条 / 命中 ${r.hitCount} 条 — ${r.question.slice(0, 50)}`)
