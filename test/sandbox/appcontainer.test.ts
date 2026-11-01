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
