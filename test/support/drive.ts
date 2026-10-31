/** 测试驱动：发一条用户消息并等 agent 回到 idle。 */
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

export async function runTurn(ctx: Context, text: string, opts: { cwd: string; sessionId?: string }): Promise<{ events: unknown[]; final: unknown }> {
  if (ctx == null || typeof (ctx as { on?: unknown }).on !== 'function') {
    throw new Error(`runTurn: bad ctx (type=${typeof ctx}, keys=${ctx ? Object.keys(ctx) : 'null'})`)
  }
  const events: unknown[] = []
  const snap = (e: unknown): unknown => {
    try { return JSON.parse(JSON.stringify(e)) } catch { return { type: (e as { type?: string })?.type } }
  }
  (ctx as any).events?.on?.('agent/assistant-stream', (e: unknown) => events.push(snap(e)))
  const agents = ctx.get('agents') as unknown as {
    create(o: { sessionId: unknown; meta?: { cwd?: string }; agentOptions?: { provider: string; model: string } }): Promise<{ agent: AgentLike; dispose(): Promise<void> }>
  }
  const sessionId = opts.sessionId ?? randomUUID()
  const { agent } = await agents.create({
    sessionId: sessionId as never,
    meta: { cwd: opts.cwd },
    agentOptions: { provider: 'deepseek-official', model: 'fake-1' },
  } as never)
  const idle = waitIdle(agent, 30000)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  const final = await idle
  return { events, final }
}

interface AgentLike {
  status: string
  followup(msg: unknown): void
}

function waitIdle(agent: AgentLike, ms: number): Promise<unknown> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (agent.status === 'idle' && Date.now() - t0 > 200) return resolve({ status: 'idle', elapsed: Date.now() - t0 })
      if (Date.now() - t0 > ms) return reject(new Error(`agent did not reach idle in ${ms}ms (status=${agent.status})`))
      setTimeout(tick, 50)
    }
    setTimeout(tick, 150)
  })
}
