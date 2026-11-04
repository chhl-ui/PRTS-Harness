/**
 * 所有者通道（P2）端到端回归：协议往返、审批态状态机、单客户端、断开、宿主回显。
 *
 * 组装方式**刻意与 src/cli/chat-serve.ts 一致**：createTerminalServer → startRuntime →
 * runChat，deps 里 out 接 host 通道、onAssistantDelta 接 delta 通道、
 * approvalChannel 接 requestApproval。任何一个环节只在入口接、测试里没接，
 * 这里就会红。
 *
 * E10（Low 完整性进程连不上真实产品管道）不在这里——它要求沙箱模块与相应特权，
 * 放在 test/e10/gate.mjs 由 `npm run verify:e10` 单独跑。**验收判据是该脚本的
 * exit 0，不是本文件全绿。**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { runChat, describeOpenTasks } from '../../src/cli/chat.ts'
import { createTerminalServer } from '../../src/runtime/terminal-server.ts'
import { ownerTermPipeName, pipeConnect, lineParser, encode } from '../../src/runtime/owner-protocol.ts'
import type { OwnerPush } from '../../src/runtime/owner-protocol.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { prtsYml, PATCHES } from '../support/composition.ts'
import type { ScriptedStep } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Socket } from 'node:net'

// prtsYml / PATCHES 来自 test/support/composition.ts，与 e3-approval.test.ts 共用——
// 「审批在管道入口下依然可达」依赖两边组装参数逐项相同，这只能靠共用常量保证。

interface Rig {
  pipeName: string
  term: ReturnType<typeof createTerminalServer>
  app: Awaited<ReturnType<typeof startRuntime>>
  done: Promise<{ turns: number }>
  close(): Promise<void>
}

/** 与 chat-serve.ts 同构的组装。 */
async function rig(dataRoot: string, ws: string, script: ScriptedStep[]): Promise<Rig> {
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })
  const pipeName = ownerTermPipeName()
  const term = createTerminalServer(pipeName)
  const app = await startRuntime({
    configPath: prtsYml,
    dataRoot,
    workspace: ws,
    mode: 'normal',
    patches: PATCHES,
  })
  scriptedLlmPlugin(script).apply(app.ctx as Context)

  const hint = describeOpenTasks(app.ledger)
  if (hint !== '') term.pushHostOutput(hint + '\n')

  // 与改造后的 chat-serve 同构：先 accept 再跑 runChat（服务端等客户端，而不是先建流）。
  const done = (async () => {
    const lines = await term.accept()
    if (lines === undefined) return { turns: 0, replies: [] as string[] }
    return runChat({
      ctx: app.ctx,
      lines,
      out: (text) => term.pushHostOutput(text),
      cwd: ws,
      dataRoot,
      sessionId: 'pipe-test-session',
      ledger: app.ledger,
      authority: app.authority,
      approvalBridge: app.approvalBridge,
      draftTaskForSession: app.draftTaskForSession,
      onAssistantDelta: (text) => term.pushModelDelta(text),
      approvalChannel: { ask: (info) => term.requestApproval(info) },
      onTurnEnd: (info) => term.pushTurnEnd(info.text ?? ''),
    })
  })()

  return {
    pipeName,
    term,
    app,
    done,
    async close() {
      term.close()
      await done.catch(() => ({ turns: 0 }))
      await app.dispose()
    },
  }
}

interface Client {
  socket: Socket
  pushes: OwnerPush[]
  send(msg: unknown): void
  waitFor(pred: (p: OwnerPush) => boolean, ms?: number): Promise<OwnerPush>
  end(): void
}

async function connect(pipeName: string): Promise<Client> {
  const socket = await pipeConnect(pipeName)
  const pushes: OwnerPush[] = []
  const waiters: { pred: (p: OwnerPush) => boolean; resolve: (p: OwnerPush) => void }[] = []
  socket.on('data', lineParser((msg) => {
    const push = msg as OwnerPush
    pushes.push(push)
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(push)) {
        const w = waiters.splice(i, 1)[0]
        w.resolve(push)
      }
    }
  }, () => {}))
  return {
    socket,
    pushes,
    send: (msg) => { socket.write(encode(msg)) },
    waitFor(pred, ms = 8000) {
      const hit = pushes.find(pred)
      if (hit !== undefined) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待推送超时')), ms)
        waiters.push({
          pred,
          resolve: (p) => { clearTimeout(timer); resolve(p) },
        })
      })
    },
    end: () => { socket.destroy() },
  }
}

test('⑦ 管道名随机且格式固定，两次生成不同', () => {
  const a = ownerTermPipeName()
  const b = ownerTermPipeName()
  assert.notEqual(a, b)
  for (const n of [a, b]) {
    assert.match(n, /^\\\\\.\\pipe\\prts-term-[0-9a-f]{32}$/)
  }
})

test('① 协议往返：prompt → delta 完整到达且无重复 + turn-end', { timeout: 180000 }, async () => {
  const t = makeTmp('pipe-roundtrip-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  const r = await rig(dataRoot, ws, [{ text: '收到，开始处理。' }])
  const c = await connect(r.pipeName)
  try {
    c.send({ type: 'prompt', text: '你好' })
    await c.waitFor((p) => p.type === 'status')
    await c.waitFor((p) => p.type === 'event' && p.kind === 'turn-end')
    const text = c.pushes
      .filter((p): p is Extract<OwnerPush, { type: 'event' }> => p.type === 'event' && p.kind === 'delta')
      .map((p) => p.text)
      .join('')
    assert.equal(text, '收到，开始处理。', `delta 拼接应等于整段回复，实际 ${JSON.stringify(text)}`)
  } finally {
    c.end()
    await r.close()
    t.cleanup()
  }
})

test('⑥ 宿主回显走 host 通道，且不产生新回合', { timeout: 180000 }, async () => {
  const t = makeTmp('pipe-host-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  const r = await rig(dataRoot, ws, [{ text: '不该被调用' }])
  const c = await connect(r.pipeName)
  try {
    c.send({ type: 'prompt', text: '/tasks' })
    const host = await c.waitFor((p) => p.type === 'event' && p.kind === 'host')
    assert.match((host as { text: string }).text, /账本|任务|还没有/, '宿主回显应说明任务列表')
    // 宿主命令不触发模型回合：不应出现 delta
    await new Promise((res) => setTimeout(res, 300))
    const deltas = c.pushes.filter((p) => p.type === 'event' && p.kind === 'delta')
    assert.equal(deltas.length, 0, '/tasks 被当成了提示词发给模型（出现 delta）')
  } finally {
    c.end()
    await r.close()
    t.cleanup()
  }
})

test('③ 单客户端：第二个连接收到 busy 并被断开', { timeout: 180000 }, async () => {
  const t = makeTmp('pipe-busy-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  const r = await rig(dataRoot, ws, [{ text: 'ok' }])
  const name = r.pipeName
  const first = await connect(name)
  await first.waitFor((p) => p.type === 'status')
  try {
    const second = await connect(name)
    const err = await second.waitFor((p) => p.type === 'error')
    assert.equal((err as { code: string }).code, 'busy')
  } finally {
    first.end()
    await r.close()
    t.cleanup()
  }
})

test('④a 空闲态断开：runChat 5s 内退出', { timeout: 180000 }, async () => {
  const t = makeTmp('pipe-eof-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  const r = await rig(dataRoot, ws, [{ text: 'ok' }])
  const c = await connect(r.pipeName)
  await c.waitFor((p) => p.type === 'status')
  c.end()
  const started = Date.now()
  await r.done
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5000, `空闲断开后 ${elapsed}ms 才退出，期望 5s 内`)
  await r.close()
  t.cleanup()
})

test('② 审批态：无 pending 的应答被拒；错 callId 被拒；正确 callId 才结算', { timeout: 180000 }, async () => {
  const t = makeTmp('pipe-approval-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  const r = await rig(dataRoot, ws, [{ text: 'ok' }])
  const c = await connect(r.pipeName)
  try {
    await c.waitFor((p) => p.type === 'status')
    // (a) 没有待审批时发 answer → stale-approval
    c.send({ type: 'approval.answer', callId: 'nope', allow: true })
    const e1 = await c.waitFor((p) => p.type === 'error')
    assert.equal((e1 as { code: string }).code, 'stale-approval')

    // (c) 有 pending 但 callId 不符 → stale-approval，且不结算
    const asked = r.term.requestApproval({
      callId: 'call-1', tool: 'write', capabilities: ['fs.write:C:\\outside'], reason: 'test',
    })
    await c.waitFor((p) => p.type === 'approval.request')
    c.send({ type: 'approval.answer', callId: 'call-0', allow: true })
    await c.waitFor((p) => p.type === 'error' && p.code === 'stale-approval')
    // 此时仍未结算：再发正确答案才 resolve
    c.send({ type: 'approval.answer', callId: 'call-1', allow: true })
    assert.equal(await asked, true, '匹配 callId 的 allow:true 应结算为允许')

    // (b) 审批期内发 prompt 不入队
    const pending2 = r.term.requestApproval({
      callId: 'call-2', tool: 'edit', capabilities: ['fs.write:C:\\outside'], reason: 'test2',
    })
    await c.waitFor((p) => p.type === 'approval.request' && p.callId === 'call-2')
    c.send({ type: 'prompt', text: '这行不该入队' })
    await c.waitFor((p) => p.type === 'error' && p.code === 'bad-request')
    c.send({ type: 'approval.answer', callId: 'call-2', allow: false })
    assert.equal(await pending2, false)
  } finally {
    c.end()
    await r.close()
    t.cleanup()
  }
})

test('② 真实链路：模型调工作区外 write → pre-execute ask → 管道审批 → 工具执行', { timeout: 180000 }, async () => {
  // 与上面那条注入式用例的分工：那条验状态机边界（无 pending / 错 callId / 审批期 prompt），
  // 这条验端到端——审批请求是模型的动作真的触发的，不是测试塞进去的。
  // 没有这条，「管道里的审批」只能证明我们能自己把消息喂给自己。
  const t = makeTmp('pipe-e2e-approval-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  const outside = join(t.dir, 'outside')
  mkdirSync(outside, { recursive: true })
  const target = join(outside, 'approved.txt')

  const r = await rig(dataRoot, ws, [
    { toolCalls: [{ name: 'write', arguments: { file_path: target, content: 'p2-payload' } }] },
    { text: 'done' },
  ])
  const c = await connect(r.pipeName)
  try {
    await c.waitFor((p) => p.type === 'status')
    c.send({ type: 'prompt', text: 'write it' })

    const req = await c.waitFor((p) => p.type === 'approval.request')
    assert.equal((req as { tool: string }).tool, 'write', '审批请求应来自模型发起的 write')
    assert.equal(existsSync(target), false, '审批还没应答，文件不该已经落盘')

    c.send({ type: 'approval.answer', callId: (req as { callId: string }).callId, allow: true })
    await c.waitFor((p) => p.type === 'event' && p.kind === 'turn-end')

    assert.equal(existsSync(target), true, '已批准但文件未落盘——审批结果没走到 guard')
    assert.equal(readFileSync(target, 'utf8'), 'p2-payload', '落盘内容不符')
  } finally {
    c.end()
    await r.close()
    t.cleanup()
  }
})

test('⑧ 断开重连：同一 runtime 下第二个客户端继续对话，agent 复用', { timeout: 180000 }, async () => {
  const t = makeTmp('pipe-reconnect-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })
  const pipeName = ownerTermPipeName()
  const term = createTerminalServer(pipeName)
  const app = await startRuntime({
    configPath: prtsYml,
    dataRoot,
    workspace: ws,
    mode: 'normal',
    patches: PATCHES,
  })
  scriptedLlmPlugin([{ text: '第一轮回复' }, { text: '第二轮回复' }]).apply(app.ctx as Context)

  // 与 chat-serve 的 accept 循环同构：断开只结束本代，回到 accept 等下一个客户端。
  const serve = (async (): Promise<number> => {
    let turns = 0
    for (;;) {
      const lines = await term.accept()
      if (lines === undefined) return turns
      const r = await runChat({
        ctx: app.ctx,
        lines,
        out: (text) => term.pushHostOutput(text),
        cwd: ws,
        dataRoot,
        sessionId: 'e2e-reconnect',
        ledger: app.ledger,
        authority: app.authority,
        approvalBridge: app.approvalBridge,
        draftTaskForSession: app.draftTaskForSession,
        onAssistantDelta: (text) => term.pushModelDelta(text),
        approvalChannel: { ask: (info) => term.requestApproval(info) },
        onTurnEnd: (info) => term.pushTurnEnd(info.text ?? ''),
      })
      turns += r.turns
      term.endSession()
    }
  })()

  try {
    const c1 = await connect(pipeName)
    await c1.waitFor((p) => p.type === 'status')
    c1.send({ type: 'prompt', text: '你好' })
    await c1.waitFor((p) => p.type === 'event' && p.kind === 'turn-end')
    c1.end()

    // 服务端处理断开是异步的：忙时重试，直到拿到 status。
    let c2: Client | undefined
    const started = Date.now()
    while (c2 === undefined) {
      const c = await connect(pipeName)
      const first = await Promise.race([
        c.waitFor((p) => p.type === 'status' || p.type === 'error', 2000).catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
      ])
      if (first !== undefined && first.type === 'status') {
        c2 = c
        break
      }
      c.end()
      if (Date.now() - started > 8000) throw new Error('重连超时：服务端没有回到可接受状态')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    c2.send({ type: 'prompt', text: '再来' })
    await c2.waitFor((p) => p.type === 'event' && p.kind === 'turn-end')
    const deltas = c2.pushes
      .filter((p): p is Extract<OwnerPush, { type: 'event' }> => p.type === 'event' && p.kind === 'delta')
      .map((p) => p.text)
      .join('')
    assert.equal(deltas, '第二轮回复', `重连后应拿到第二轮回复，实际 ${JSON.stringify(deltas)}`)
    const live = (app.ctx.get('agents') as { list(): unknown[] }).list()
    assert.equal(live.length, 1, '重连必须复用同一 agent，而不是新建')
    c2.end()
  } finally {
    term.close()
    await serve.catch(() => 0)
    await app.dispose()
    t.cleanup()
  }
})
