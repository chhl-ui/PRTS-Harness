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
      /**
       * 心跳：每 `PRTS_HEARTBEAT_MS` 毫秒一次（0 / 非法 = 关闭）。
       *
       * 这是 Watchdog 的「进展」信号。**同步阻塞会让事件循环停摆，心跳随之停止**——
       * 守护进程据此判断「进程活着但卡死」（2026-11-04 实测：全量 20 轮第 5/11/15 轮
       * 挂起，CPU 2.5s / 存活 90s，正是这个形态）。
       *
       * `unref()`：心跳不能阻止进程退出——它只是给外界看的信号。
       */
      const hbRaw = Number(process.env.PRTS_HEARTBEAT_MS ?? '5000')
      const hbMs = Number.isFinite(hbRaw) && hbRaw > 0 ? Math.floor(hbRaw) : 0
      const hb = hbMs > 0
        ? setInterval(() => {
          try { sock.write(encode({ type: 'heartbeat', at: Date.now() })) } catch { /* gone */ }
        }, hbMs)
        : undefined
      if (hb !== undefined) hb.unref?.()
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
      resolve({ close: () => { if (hb !== undefined) clearInterval(hb); try { sock.destroy() } catch { /* ignore */ } } })
    })
  })
}
