/** K3 运行时侧控制管道客户端：读取 env 后立即删除（防子进程继承），hello 认证，处理 stop。 */
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { lineParser, encode } from '../supervisor/protocol.ts'

export type RuntimeStopLevel = 'S0' | 'S1' | 'S2'

/**
 * 连接守护进程控制管道。**必须先于任何子进程派生调用**——
 * 本函数读取后立即从 process.env 删除 PRTS_CONTROL_PIPE/TOKEN，
 * 之后派生的子进程拿不到管道名与令牌。
 */
export function connectControl(handlers: {
  onStop(level: RuntimeStopLevel): Promise<unknown>
}): Promise<{ close(): void }> {
  const pipe = process.env.PRTS_CONTROL_PIPE
  const token = process.env.PRTS_CONTROL_TOKEN
  delete process.env.PRTS_CONTROL_PIPE
  delete process.env.PRTS_CONTROL_TOKEN
  if (!pipe || !token) {
    return Promise.reject(new Error('PRTS_CONTROL_PIPE/PRTS_CONTROL_TOKEN missing'))
  }
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(pipe)
    sock.once('error', reject)
    sock.once('connect', () => {
      sock.write(encode({ type: 'hello', pid: process.pid, token }))
      sock.on('data', lineParser(
        (msg) => {
          const m = msg as { type?: string; id?: string; level?: RuntimeStopLevel }
          if (m?.type === 'stop' && typeof m.id === 'string') {
            void handlers.onStop(m.level ?? 'S2').then((report) => {
              try { sock.write(encode({ type: 'stopped', id: m.id, report })) } catch { /* gone */ }
            }).catch(() => { /* 不回包 → 守护进程按超时升级 S3 */ })
          }
        },
        () => { /* 畸形行丢弃 */ },
      ))
      resolve({ close: () => { try { sock.destroy() } catch { /* ignore */ } } })
    })
  })
}
