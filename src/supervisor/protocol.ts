/** K3 控制协议：命名管道 + 按行 JSON，每条消息带 id。仅 Windows 命名管道。 */
import { createServer, connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { Server, Socket } from 'node:net'

export type StopLevel = 'S0' | 'S1' | 'S2' | 'S3'

export interface StopRequest { type: 'stop'; id: string; level: StopLevel }
export interface StatusRequest { type: 'status'; id: string }
export type OwnerRequest = StopRequest | StatusRequest

export function runtimePipeName(): string {
  return `\\\\.\\pipe\\prts-rt-${randomUUID().replace(/-/g, '')}`
}

export function ownerPipeName(name: string): string {
  return `\\\\.\\pipe\\prts-owner-${name}`
}

export function encode(msg: unknown): string {
  return JSON.stringify(msg) + '\n'
}

/** 逐行 JSON 解码器：坏行不抛出，交给 onError 回调（不崩溃守护进程）。 */
export function lineParser(onLine: (msg: unknown) => void, onError: (raw: string) => void): (chunk: Buffer | string) => void {
  let buf = ''
  return (chunk) => {
    buf += String(chunk)
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line === '') continue
      try { onLine(JSON.parse(line)) } catch { onError(line) }
    }
  }
}

/** 监听一条命名管道；nextClient 按到达顺序返回连接的 socket。 */
export function listenPipe(pipe: string): {
  server: Server
  nextClient: () => Promise<Socket>
  close: () => void
} {
  const pending: Socket[] = []
  const waiters: ((s: Socket) => void)[] = []
  const server = createServer((socket) => {
    const cb = waiters.shift()
    if (cb) cb(socket)
    else pending.push(socket)
  })
  server.listen(pipe)
  return {
    server,
    nextClient: () => new Promise<Socket>((resolve) => {
      const s = pending.shift()
      if (s) resolve(s)
      else waiters.push(resolve)
    }),
    close: () => { try { server.close() } catch { /* 已关 */ } },
  }
}

/** 连上运行时控制管道并发送一行消息。 */
export function pipeConnect(pipe: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(pipe)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
}
