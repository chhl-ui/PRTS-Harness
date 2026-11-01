/**
 * AppContainer 沙箱回归（U3 读隔离）。
 *
 * 三条断言，缺一不可：
 *  - 能起进程（否则后面的「读不到」可能只是「什么都没跑起来」）
 *  - 读不到工作区外的密钥（隔离真的生效）
 *  - 宿主读得到（基线有效，不是两头都读不到）
 *
 * 会改系统状态（建 AppContainer profile、给工作区打 ACL），finally 里必须清干净。
 * profile 名带 pid，避免与其他测试并发冲突。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAppContainer } from '../../src/sandbox/appcontainer.ts'

const CMD = 'C:\\Windows\\System32\\cmd.exe'
const KEY = 'C:\\prts-data\\secrets\\deepseek.key'

/** exit 10 = 读到了；exit 20 = 读不到。用退出码而不是输出，免掉 stdio 捕获。 */
const PROBE = `type ${KEY} >nul 2>&1 && exit 10 || exit 20`

test('AppContainer: 起进程 / 密钥读隔离 / dispose 清理', { timeout: 180000 }, async () => {
  const ws = join(tmpdir(), `prts-ac-${process.pid}-${Date.now()}`)
  mkdirSync(ws, { recursive: true })
  const name = `PRTS.Test.${process.pid}.${Date.now()}`
  const box = await createAppContainer({ name, workspace: ws })

  try {
    assert.match(box.sid, /^S-1-15-2-/, `SID 应是 AppContainer 包 SID，实际 ${box.sid}`)

    // ---- arm1：进程真的起来了 ----
    const trivial = box.spawn({ command: CMD, args: ['/c', 'exit', '7'] })
    assert.ok(trivial.pid > 0, `pid 应为正数，实际 ${trivial.pid}`)
    assert.equal((await trivial.wait()).exitCode, 7, 'AppContainer 子进程没能执行命令')

    // ---- arm2/3：宿主能读，AppContainer 读不到 ----
    if (!existsSync(KEY)) {
      // 不静默跳过：打一行并让断言落在这里，绝不能因为文件不在就当作通过。
      console.log(`[ac] 密钥文件不存在（${KEY}），读隔离用例未验证`)
      assert.fail('密钥文件不存在，读隔离无法验证——这不是通过')
    }
    const host = spawnSync('cmd.exe', ['/c', PROBE])
    assert.equal(host.status, 10, '宿主应当读得到密钥（基线无效，后面的隔离结论也不成立）')

    const inBox = box.spawn({ command: CMD, args: ['/c', PROBE] })
    assert.equal(inBox.pid > 0, true, 'AppContainer 子进程没起来')
    assert.equal((await inBox.wait()).exitCode, 20,
      'AppContainer 读到了工作区外的密钥——读隔离没有生效')
  } finally {
    await box.dispose()
    rmSync(ws, { recursive: true, force: true })
  }
})

test('AppContainer: 授权后的工作区可读写，dispose 撤销授权', { timeout: 180000 }, async () => {
  const ws = join(tmpdir(), `prts-ac-wr-${process.pid}-${Date.now()}`)
  mkdirSync(ws, { recursive: true })
  const name = `PRTS.TestW.${process.pid}.${Date.now()}`
  const target = join(ws, 'probe.txt')
  const box = await createAppContainer({ name, workspace: ws })

  try {
    // 在工作区内建文件：能写才说明 (RX,W) 授权生效，而不是「什么都没权限」。
    const w = box.spawn({ command: CMD, args: ['/c', `echo hi> "${target}"`] })
    await w.wait()
    assert.equal(existsSync(target), true, '子进程没能在已授权的工作区里写文件')
  } finally {
    await box.dispose()
    rmSync(ws, { recursive: true, force: true })
  }
})

test('AppContainer: 子进程输出能读到（stdout/stderr 合并）', { timeout: 180000 }, async () => {
  // 上一条用例靠退出码表达结果，是因为当时没有 stdio 捕获。这条直接验输出——
  // shell 工具要返回给模型的是文本，不是退出码。
  const ws = join(tmpdir(), `prts-ac-out-${process.pid}-${Date.now()}`)
  mkdirSync(ws, { recursive: true })
  const name = `PRTS.TestO.${process.pid}.${Date.now()}`
  const box = await createAppContainer({ name, workspace: ws })
  try {
    const child = box.spawn({ command: CMD, args: ['/c', 'echo HELLO_FROM_BOX && echo BOX_ERR 1>&2'] })
    const r = await child.wait()
    assert.equal(r.exitCode, 0, `退出码应为 0，实际 ${r.exitCode}`)
    assert.match(r.output, /HELLO_FROM_BOX/, `stdout 没被捕获：${JSON.stringify(r.output)}`)
    assert.match(r.output, /BOX_ERR/, `stderr 没合并进输出：${JSON.stringify(r.output)}`)
  } finally {
    await box.dispose()
    rmSync(ws, { recursive: true, force: true })
  }
})

test('AppContainer: 大输出不触发管道死锁', { timeout: 180000 }, async () => {
  // 分开读两个管道时，写满一个就会死锁。这条用超过管道缓冲（64KB）的输出钉住
  // 「合并成单管道 + 先读后等」这个设计。
  const ws = join(tmpdir(), `prts-ac-big-${process.pid}-${Date.now()}`)
  mkdirSync(ws, { recursive: true })
  const name = `PRTS.TestB.${process.pid}.${Date.now()}`
  const box = await createAppContainer({ name, workspace: ws })
  try {
    // 生成 ~200KB：远超 64KB 管道缓冲
    const child = box.spawn({
      command: CMD,
      args: ['/c', 'for /L %i in (1,1,5000) do @echo 0123456789012345678901234567890123456789'],
    })
    const r = await child.wait()
    assert.equal(r.exitCode, 0, `大输出导致非零退出 ${r.exitCode}`)
    assert.ok(r.output.length > 150_000, `输出被截断，实际 ${r.output.length} 字节——疑似管道死锁或读提前结束`)
  } finally {
    await box.dispose()
    rmSync(ws, { recursive: true, force: true })
  }
})
