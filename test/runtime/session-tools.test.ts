/**
 * `prts_session_archive`：模型自主结束会话的入口。
 *
 * 工具本身**不切换会话**，只往当前会话日志追加 `archive/requested` 事件；
 * 真正的切换在 `runChat` 主循环下一轮开头执行（那里够得着 `applySwitch`）。
 * 所以这里钉的是「事件写对了」和「写不进时必须报错」这两条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionTools } from '../../src/runtime/session-tools.ts'

interface Captured {
  name: string
  description: string
  parameters: { properties?: Record<string, unknown> }
  execute: (args: unknown, exec?: unknown) => Promise<unknown>
}

function fakeRegistry(): { registry: { register(d: unknown): () => void }; get(name: string): Captured } {
  const defs = new Map<string, Captured>()
  return {
    registry: {
      register(d: unknown): () => void {
        const def = d as Captured
        defs.set(def.name, def)
        return () => { defs.delete(def.name) }
      },
    },
    get(name: string): Captured {
      const d = defs.get(name)
      if (d === undefined) throw new Error(`未注册的工具: ${name}（已注册 ${[...defs.keys()].join(',')}）`)
      return d
    },
  }
}

test('SA1 prts_session_archive：把 archive/requested 事件追加到当前会话', async () => {
  const appended: Array<{ type: string; data: unknown }> = []
  const session = {
    append: (type: string, data: unknown) => { appended.push({ type, data }) },
  }
  const { registry, get } = fakeRegistry()
  createSessionTools(registry as never)

  const out = await get('prts_session_archive').execute(
    { reason: '这一章告一段落' },
    { agent: { session } },
  ) as { requested?: boolean; note?: string }

  assert.equal(out.requested, true)
  assert.equal(appended.length, 1, '应只写一条事件')
  assert.equal(appended[0]?.type, 'archive/requested')
  const data = appended[0]?.data as { reason?: string; at?: number }
  assert.equal(data.reason, '这一章告一段落')
  assert.ok(typeof data.at === 'number' && data.at > 0, '应带时间戳')
})

test('SA2 会话不支持 append 时 fail-closed，不返回成功', async () => {
  const { registry, get } = fakeRegistry()
  createSessionTools(registry as never)

  for (const badExec of [undefined, {}, { agent: {} }, { agent: { session: {} } }]) {
    await assert.rejects(
      () => get('prts_session_archive').execute({}, badExec),
      /不支持追加事件|无法记录归档请求/,
      `exec=${JSON.stringify(badExec)} 应拒绝`,
    )
  }
})

test('SA3 append 抛错时把原因带出来，不让模型以为切过了', async () => {
  const session = {
    append: () => { throw new Error('磁盘满') },
  }
  const { registry, get } = fakeRegistry()
  createSessionTools(registry as never)

  await assert.rejects(
    () => get('prts_session_archive').execute({}, { agent: { session } }),
    /磁盘满/,
  )
})

test('SA4 dispose 注销工具', () => {
  const { registry, get } = fakeRegistry()
  const tools = createSessionTools(registry as never)
  assert.equal(tools.names.length, 2, 'archive + recall 两个工具')
  tools.dispose()
  assert.equal(tools.names.length, 0)
  assert.throws(() => get('prts_session_archive'), /未注册的工具/)
})
