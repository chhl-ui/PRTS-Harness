/**
 * 所有者通道的多会话生命周期（客户端寿命与运行时寿命解耦的协议层）。
 *
 * 现状改造前：客户端断开 → `lines` 永久 EOF（`closed=true`）→ 服务端只能退出。
 * 改造后：断开只结束**本代**会话；`accept()` 等下一个客户端，同一个服务端继续服务。
 *
 * 本文件只测协议层（不启 runtime、不跑模型）——重连后消息能否进对的 agent
 * 由 `test/runtime/terminal-reconnect.test.ts` 与 chat.ts 的复用逻辑单测覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Socket } from 'node:net'
import { createTerminalServer } from '../../src/runtime/terminal-server.ts'
import { ownerTermPipeName, pipeConnect, lineParser, encode } from '../../src/runtime/owner-protocol.ts'
import type { OwnerPush } from '../../src/runtime/owner-protocol.ts'

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
    waitFor(pred, ms = 5000) {
      const hit = pushes.find(pred)
      if (hit !== undefined) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待推送超时')), ms)
        waiters.push({ pred, resolve: (p) => { clearTimeout(timer); resolve(p) } })
      })
    },
    end: () => { socket.destroy() },
  }
}

test('RT1 accept 返回当前连接的输入流，prompt 原样到达', async () => {
  const term = createTerminalServer(ownerTermPipeName())
  try {
    const accepting = term.accept()
    const c = await connect(term.pipeName)
    const lines = await accepting
    assert.notEqual(lines, undefined, 'accept 应拿到第一代会话')
    const it = lines![Symbol.asyncIterator]()
    c.send({ type: 'prompt', text: 'hello' })
    assert.equal((await it.next()).value, 'hello')
  } finally { term.close() }
})

test('RT2 断开只结束本代：重连后 accept 拿到新一代输入流', async () => {
  const term = createTerminalServer(ownerTermPipeName())
  try {
    // 客户端先连、accept 后调——验证「已连接但未被消费」的被缓存。
    const c1 = await connect(term.pipeName)
    const lines1 = await term.accept()
    assert.notEqual(lines1, undefined)
    const it1 = lines1![Symbol.asyncIterator]()
    c1.send({ type: 'prompt', text: 'one' })
    assert.equal((await it1.next()).value, 'one')

    c1.end()
    assert.equal((await it1.next()).done, true, '断开必须让本代输入流 EOF')

    const accepting2 = term.accept()
    const c2 = await connect(term.pipeName)
    const lines2 = await accepting2
    assert.notEqual(lines2, undefined, '重连必须拿到新一代会话，而不是永久 EOF')
    const it2 = lines2![Symbol.asyncIterator]()
    c2.send({ type: 'prompt', text: 'two' })
    assert.equal((await it2.next()).value, 'two')
  } finally { term.close() }
})

test('RT3 同一时刻仍只接受一个客户端（busy）', async () => {
  const term = createTerminalServer(ownerTermPipeName())
  try {
    const c1 = await connect(term.pipeName)
    await term.accept()
    const c2 = await connect(term.pipeName)
    const err = await c2.waitFor((p) => p.type === 'error')
    assert.equal((err as { code: string }).code, 'busy')
    c1.end()
  } finally { term.close() }
})

test('RT4 endSession：服务端主动结束当前连接（/exit 后等下一个客户端）', async () => {
  const term = createTerminalServer(ownerTermPipeName())
  try {
    const c1 = await connect(term.pipeName)
    const lines1 = await term.accept()
    const it1 = lines1![Symbol.asyncIterator]()
    term.endSession()
    assert.equal((await it1.next()).done, true, 'endSession 必须让本代输入流 EOF')

    const accepting2 = term.accept()
    const c2 = await connect(term.pipeName)
    assert.notEqual(await accepting2, undefined, 'endSession 后仍能接受新客户端')
    c2.end()
  } finally { term.close() }
})

test('RT5 close 是终局：accept 返回 undefined，当前连接被断开', async () => {
  const term = createTerminalServer(ownerTermPipeName())
  try {
    const c1 = await connect(term.pipeName)
    const lines1 = await term.accept()
    const it1 = lines1![Symbol.asyncIterator]()
    term.close()
    const closed = await it1.next()
    assert.equal(closed.done, true)
    assert.equal(await term.accept(), undefined, 'close 之后 accept 必须返回 undefined')
  } finally { term.close() }
})
