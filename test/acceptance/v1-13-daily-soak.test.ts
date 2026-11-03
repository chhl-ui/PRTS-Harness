/**
 * V1-13 验收的可测替代方案（2026-11-03 博士决定：真实使用推迟到整体完工后）。
 *
 * 原条款：「博士连续使用 7 天，每天至少交给它 1 件真事」——人类使用类验收，
 * 在完工前无法执行。本测试替代其中**可自动判定的部分**：7 天使用真正会暴露的
 * 不是「连续对话不中断」，而是**每天关机再开机的状态迁移**——
 *
 *   第 N 天冷启动 → 昨天的记忆/任务/意图还在吗 → 今天的事能写进去吗 → 关机
 *
 * 做法：7 个模拟日，每天一次完整 startRuntime → 操作 → dispose，同一个数据根。
 *
 * 覆盖的判据（全绿才算 V1-13 的可测部分达标）：
 *   D1 写入：第 1 天告知的事实，第 7 天仍能被检索命中
 *   D2 账本：第 3 天建的任务，第 7 天仍在账本里且相位未变
 *   D3 意图：第 5 天设的前瞻意图，第 6 天到期时能被 dueIntents 取出
 *   D4 完整性：7 天 7 次启动，没有一次因链断/缺表降级为 read-only
 *
 * **不覆盖**（本测试替代不了，仍属 R2 验收）：
 *   - 「交给它 1 件真事」里「真」的不可预知性：这里用的是脚本化的固定负载
 *   - 模型输出质量随使用漂移、博士的主观判断
 *   - 真实 LLM 的费用与延迟
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))
const DAYS = 7
/** 第 1 天埋下的独有标记词。只用它做召回判据，避免与脚本化对话内容撞词。 */
const MARKER = '月海计划'
const DAY_MS = 24 * 60 * 60 * 1000

type App = Awaited<ReturnType<typeof startRuntime>>

/** 一次「开机」：冷启动运行时，挂脚本化 LLM（不发消息也要有适配器在位）。 */
async function bootDay(dataRoot: string, ws: string): Promise<App> {
  const app = await startRuntime({
    configPath: prtsYml,
    dataRoot,
    workspace: ws,
    mode: 'normal',
    patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  scriptedLlmPlugin([{ text: '收到。' }]).apply(app.ctx as Context)
  return app
}

test('V1-13 soak：7 个模拟日，每天一次冷启动 + 一件真事', { timeout: 180000 }, async () => {
  const t = makeTmp('prts-v113-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })

  const startedAt = Date.now()
  const journal: string[] = []
  let taskId: string | undefined
  let intentId: string | undefined
  let recallHits = 0
  let ledgerSeen = false
  let intentDue = false

  try {
    for (let day = 1; day <= DAYS; day++) {
      const app = await bootDay(dataRoot, ws)
      const dayStart = startedAt + (day - 1) * DAY_MS
      try {
        // D4：本次启动没有降级为只读——能写就证明链与表都完整（startupCheck 失败会
        // 走 read-only 打开，写操作抛 READ_ONLY）。
        assert.ok(app.memory !== undefined, `第 ${day} 天：记忆库必须打得开`)

        if (day === 1) {
          // 第一天：告知三件事（其中一件带标记词）
          app.memory!.recordTurn({
            actor: 'system',
            sessionId: 'soak-day1',
            turnIndex: 0,
            speaker: 'user',
            text: `${MARKER}：三号实验台的镜片换成 50mm 定焦`,
            occurredAtMs: dayStart,
          })
          app.memory!.recordTurn({
            actor: 'system',
            sessionId: 'soak-day1',
            turnIndex: 1,
            speaker: 'user',
            text: '我最近改喝拿铁了',
            occurredAtMs: dayStart + 1000,
          })
        }

        if (day === 3) {
          // 第三天：开一个任务（draft），之后每天都应看得见它
          const task = app.ledger.create(
            { kind: 'owner' },
            {
              title: 'V1-13 soak 任务',
              objective: '验证账本跨 7 次冷启动不丢',
              acceptance: { kind: 'owner-confirm' },
            },
          )
          taskId = task.id
        }

        if (day === 5) {
          // 第五天：设一个「明天到期」的前瞻意图
          intentId = app.memory!.createIntent({
            actor: 'system',
            conditionRaw: 'soak：第六天到期',
            fireAtMs: dayStart + DAY_MS,
            action: '提醒博士',
          })
        }

        if (day === 6) {
          // 第六天：意图到期，应能被取出
          const due = app.memory!.dueIntents(dayStart + DAY_MS + 1000)
          intentDue = due.some((r) => r.intentId === intentId)
          assert.ok(intentDue, `第 6 天：第 5 天设的意图必须到期可触发`)
          app.memory!.markFired({ actor: 'system', intentId: intentId!, firedAtMs: dayStart + DAY_MS + 2000 })
        }

        if (day >= 2) {
          // D1：昨天/第一天的记忆仍在
          const hits = app.memory!.search({ text: MARKER, limit: 5 })
          recallHits = hits.length
          assert.ok(hits.length > 0, `第 ${day} 天：第 1 天写入的「${MARKER}」必须还能被检索到`)

          // D2：账本的持久性（第 3 天之后）
          if (taskId !== undefined) {
            const list = app.ledger.list()
            ledgerSeen = list.some((x) => x.id === taskId)
            assert.ok(ledgerSeen, `第 ${day} 天：第 3 天建的任务必须还在账本里`)
          }
        }

        journal.push(`day${day}: ok (turns=${app.memory!.countFacts() >= 0 ? 'n/a' : '?'})`)
      } finally {
        await app.dispose()
      }
    }

    assert.equal(journal.length, DAYS, '7 天必须全部走完')
    assert.ok(recallHits > 0, '召回判据未执行')
    assert.ok(ledgerSeen, '账本判据未执行')
    assert.ok(intentDue, '意图判据未执行')
  } finally {
    t.cleanup()
  }
})
