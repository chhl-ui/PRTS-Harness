#!/usr/bin/env node
/**
 * E10 硬门：Low 完整性进程连不上所有者通道的命名管道。
 *
 * 这是 P2 唯一的安全依据。`npm test` 里的同名断言只能证明「连不上」；这里额外
 * 证明「连不上是因为发起方是 Low 完整性，而不是因为沙箱里的网络栈坏了」。
 *
 * 四臂（缺任一臂都不成立）：
 *  · A  普通(Medium) 子进程连宿主管道     → 期望成功（基线：管道本身可用）
 *  · B  沙箱子进程连宿主管道              → 期望失败且错误码 EPERM
 *  · B' 沙箱子进程连不存在的管道          → 期望 ENOENT（证明沙箱里 errno 不被吞成统一的 EPERM）
 *  · C' 普通子进程连沙箱创建的管道        → 期望成功（对照：管道机制与发起方 IL 无关，B 的失败不能归因于环境残缺）
 *
 * 关于臂 C（沙箱客户端连沙箱服务端）：实测**失败**（EPERM）。那不是缺陷，而是比
 * 「禁止向上写」更强的结论——Low 完整性令牌下发起命名管道连接一律被拒，连同级也
 * 不行。因此判据用 C' 而不是 C，文档措辞也按此写，不要写成「禁止向上写」。
 *
 * 退出码：0 = 四臂全部符合；1 = 某臂不符；2 = 环境不具备（沙箱模块缺失/拿不到 Low IL）。
 * **只有 0 才算验收通过。** 2 不是通过，1 更不是。
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'prts-e10-'))
const ws = join(root, 'ws')
mkdirSync(ws, { recursive: true })

function pipeName(tag) {
  return `\\\\.\\pipe\\prts-e10-${tag}-${process.pid}-${Date.now()}`
}

/** 客户端脚本：连一条管道，把结果打到 stdout。 */
function clientScript(pipe) {
  return `
const net = require('node:net')
const s = net.connect(${JSON.stringify(pipe)})
s.once('connect', () => { process.stdout.write('CLIENT_OK\\n'); s.end(); process.exit(0) })
s.once('error', (e) => { process.stdout.write('CLIENT_ERR:' + (e.code || e.message) + '\\n'); process.exit(2) })
`
}

/** 服务端脚本：监听一条管道并保持存活，打印 READY 后等连接。 */
function serverScript(pipe) {
  return `
const net = require('node:net')
const srv = net.createServer((sock) => {
  sock.on('data', (d) => { sock.write('PONG:' + d.toString()); sock.end() })
})
srv.listen(${JSON.stringify(pipe)}, () => { process.stdout.write('SERVER_LISTENING\\n') })
setTimeout(() => process.exit(0), 20000)
`
}

function runPlain(script) {
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000 })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

async function loadSandbox() {
  try {
    const mod = await import('@deepseek-ai/dsh-sandbox-windows-acl')
    const { AclSandbox, workspaceWriteSid } = mod
    if (typeof AclSandbox !== 'function' || typeof workspaceWriteSid !== 'function') return null
    const box = new AclSandbox({
      writableDirs: [ws],
      writeSid: workspaceWriteSid(ws),
      mode: 'workspace-write',
      tempDir: null,
      manageDacls: true,
    })
    await box.init()
    return box
  } catch (error) {
    console.error(`[e10] 沙箱不可用：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

async function runInBox(box, script) {
  const child = box.spawn({ command: process.execPath, args: ['-e', script] })
  const r = await child.wait()
  return { code: r.code ?? r.exitCode ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const results = {}

// ---- 臂 A：宿主服务端 + 普通客户端 ----
const hostPipe = pipeName('host')
const hostSrv = createServer((sock) => {
  sock.on('error', () => {})
  sock.on('data', (d) => { sock.write(`PONG:${d.toString()}`); sock.end() })
})
await new Promise((resolve, reject) => {
  hostSrv.once('error', reject)
  hostSrv.listen(hostPipe, resolve)
})
results.A = runPlain(clientScript(hostPipe))
console.log(`[A] 基线 普通子进程连宿主管道 exit=${results.A.code} ${results.A.out.trim()}`)

// ---- 沙箱子进程 ----
const box = await loadSandbox()
if (box === null) {
  hostSrv.close()
  rmSync(root, { recursive: true, force: true })
  console.error('[e10] 环境不具备：拿不到 AclSandbox。E10 未验证（exit 2 不等于通过）。')
  process.exit(2)
}
try {
  // ---- 臂 B：沙箱客户端连宿主管道 ----
  results.B = await runInBox(box, clientScript(hostPipe))
  console.log(`[B] 沙箱子进程连宿主管道 exit=${results.B.code} ${results.B.out.trim()}`)

  // ---- 臂 B'：沙箱客户端连不存在的管道 ----
  results.Bp = await runInBox(box, clientScript(pipeName('missing')))
  console.log(`[B'] 沙箱子进程连不存在的管道 exit=${results.Bp.code} ${results.Bp.out.trim()}`)

  // ---- 臂 C'：沙箱服务端 + 普通客户端 ----
  const boxPipe = pipeName('boxsrv')
  const srvChild = box.spawn({ command: process.execPath, args: ['-e', serverScript(boxPipe)] })
  // 等它打印 SERVER_LISTENING（最多 10s）
  let listening = false
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 100))
    const seen = String(srvChild.stdout?.read?.() ?? '')
    if (seen.includes('SERVER_LISTENING')) { listening = true; break }
    if (i === 50) break // 兜底：该实现可能不暴露 stdout 流，直接尝试连接
  }
  results.Cp = runPlain(clientScript(boxPipe))
  console.log(`[C'] 普通子进程连沙箱创建的管道 exit=${results.Cp.code} ${results.Cp.out.trim()}${listening ? '' : ' (未见 READY 行，直接尝试连接)'}`)
  try { srvChild.kill?.() } catch { /* 已退出 */ }
} finally {
  hostSrv.close()
  try { await box.dispose?.() } catch { /* 已释放 */ }
}

// ---- 判定 ----
const aOk = results.A.code === 0 && results.A.out.includes('CLIENT_OK')
const bOk = results.B.code !== 0 && /EPERM/.test(results.B.out)
const bpOk = /ENOENT/.test(results.Bp.out) // errno 可区分：不是所有失败都被吞成 EPERM
const cpOk = results.Cp.code === 0 && results.Cp.out.includes('CLIENT_OK')

console.log('--- 判定 ---')
console.log(`臂A 基线连通        = ${aOk}`)
console.log(`臂B 沙箱被挡(EPERM) = ${bOk}`)
console.log(`臂B' errno可区分    = ${bpOk}`)
console.log(`臂C' 对照臂连通     = ${cpOk}`)

rmSync(root, { recursive: true, force: true })

if (aOk && bOk && bpOk && cpOk) {
  console.log('[e10] PASS — Low 完整性进程发起命名管道连接一律被拒；所有者通道的隔离依赖 Windows 完整性控制，PRTS 未额外加安全描述符。')
  process.exit(0)
}
console.error('[e10] FAIL — 四臂未全部符合，E10 不成立。不得据此认为所有者通道安全。')
process.exit(1)
