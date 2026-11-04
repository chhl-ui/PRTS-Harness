/**
 * workspace-acl 集成/单元测试：local WO 自动授权 + .git 对 shell 只读。
 * workspace 一律建在 C:\ 下（%TEMP% 测不出 WO 问题），显式列表追踪、逐个精确删除。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
import { startRuntime } from '../../src/runtime/start.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { runTurn } from '../support/drive.ts'
import { deriveAppContainerSid } from '../../src/sandbox/appcontainer.ts'
import {
  ensureWorkspaceWriteOwner, protectSubpathLocal, protectSubpathAppContainer, readAcl,
  type AclOutcome,
} from '../../src/sandbox/workspace-acl.ts'
import { appContainerProfileName } from '../../src/sandbox/provider.ts'
import type { Context } from '@deepseek-ai/cordis'

/**
 * 所有同步子进程都带超时。
 *
 * 无超时的 `execSync` 在高并发下会永久挂起：全量跑 15 个测试文件并行时，
 * `git` / `icacls` / `cmd` 会等文件系统锁，而同步等待本身不触发
 * `node --test` 的 120s 超时（事件循环停摆）。2026-11-04 实测：20 轮全量里
 * 第 5、11 轮挂在本文件，卡住的子进程 CPU 2.5s / 存活 90s（典型阻塞）。
 */
const RUN_TIMEOUT = 30_000
const sh = (cmd: string): string => execSync(cmd, { encoding: 'utf8', timeout: RUN_TIMEOUT, killSignal: 'SIGKILL' })

const USER_SID = sh('C:/Windows/System32/whoami.exe /user /fo csv /nh').split(',')[1].replace(/"/g, '').trim()
// 与生产同源：用 appContainerProfileName() 而不是硬编码的规范名。
// 这样 T3 断言的就是「启动时真正授出去的那个 SID」——两处不同源的形态才抓得住。
const CSID = deriveAppContainerSid(appContainerProfileName())
const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))
const created: string[] = []
const hex = () => randomBytes(3).toString('hex')
after(() => { for (const d of created) rmSync(d, { recursive: true, force: true }) })

const newWs = (name: string, withGit = true): string => {
  const p = `C:\\prts-test-acl-${name}-${hex()}`
  assert.equal(existsSync(p), false, `${p} 已存在`)
  mkdirSync(p); created.push(p)
  if (withGit) {
    sh(`git -C "${p}" -c user.name=probe -c user.email=probe@local init -q`)
    sh(`git -C "${p}" -c user.name=probe -c user.email=probe@local commit --allow-empty -qm init`)
  }
  return p
}
const dataRoot = (): string => {
  const p = mkdtempSync(join(tmpdir(), 'prts-atest-')); created.push(p)
  mkdirSync(join(p, 'data'), { recursive: true }); return join(p, 'data')
}
const icacls = (p: string): string => sh(`icacls "${p}"`)

async function transcript(dr: string): Promise<string> {
  const sessDir = join(dr, 'dsh-home', 'sessions'); let text = ''
  for (let i = 0; i < 40; i++) {
    if (existsSync(sessDir)) for (const f of readdirSync(sessDir, { recursive: true }) as string[])
      try { text += readFileSync(join(sessDir, f), 'utf8') } catch { /* dir */ }
    if (text.includes('tool/result')) break
    await new Promise(r => setTimeout(r, 250))
  }
  return text
}
async function runOps(ws: string, cmds: string[], backend: 'local' | 'appcontainer', keep?: { app: Awaited<ReturnType<typeof startRuntime>>; dr: string }) {
  const dr = keep?.dr ?? dataRoot()
  const app = keep?.app ?? await startRuntime({ configPath: prtsYml, dataRoot: dr, workspace: ws, mode: 'normal', patches: [{ id: 'llm-deepseek', disabled: true }] })
  scriptedLlmPlugin([...cmds.map(c => ({ toolCalls: [{ name: 'pwsh', arguments: { command: c } }] })), { text: 'done' }]).apply((app as { ctx: Context }).ctx)
  await runTurn((app as { ctx: Context }).ctx, 'go', { cwd: ws })
  return { app, dr }
}
const results = (t: string) => t.split('\n').filter(l => l.includes('tool/result')).map(l => (l.match(/"text":"((?:[^"\\]|\\.)*)"/)?.[1] ?? ''))

const withBackend = async <T>(b: 'local' | 'appcontainer', fn: () => Promise<T>): Promise<T> => {
  const prev = process.env.PRTS_SANDBOX_BACKEND; process.env.PRTS_SANDBOX_BACKEND = b
  try { return await fn() } finally { prev === undefined ? delete process.env.PRTS_SANDBOX_BACKEND : process.env.PRTS_SANDBOX_BACKEND = prev }
}
const gitCheck = (ws: string) => {
  assert.equal(spawnSync('git', ['-C', ws, '-c', 'user.name=probe', '-c', 'user.email=probe@local', 'commit', '--allow-empty', '-qm', 'h'], { encoding: 'utf8', timeout: RUN_TIMEOUT }).status, 0, 'host commit')
  assert.equal(spawnSync('git', ['-C', ws, 'fsck'], { encoding: 'utf8', timeout: RUN_TIMEOUT }).status, 0, 'host fsck')
}

test('T1 local: 无预授权的 C:\\ ws 自动 WO，pwsh 写区内成功/区外被拒，无旧横幅', { timeout: 240000 }, async () => {
  const ws = newWs('t1', false)
  const outside = `C:\\prts-test-acl-out-${hex()}`; mkdirSync(outside); created.push(outside)
  const warns: string[] = []
  const ow = console.warn; console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); ow(...a) }
  const errs: string[] = []
  const oe = console.error; console.error = (...a: unknown[]) => { errs.push(a.join(' ')); oe(...a) }
  let out: Awaited<ReturnType<typeof runOps>> | undefined
  try { out = await withBackend('local', () => runOps(ws, [`Set-Content "${ws}\\t1.txt" t1`, `Set-Content "${outside}\\o.txt" o`], 'local')) }
  finally { console.warn = ow; console.error = oe }
  results(await transcript(out!.dr))
  assert.equal(existsSync(join(ws, 't1.txt')), true, '区内文件应写出')
  assert.equal(existsSync(join(outside, 'o.txt')), false, '区外应被拒')
  assert.equal(warns.some(w => w.includes('起不了 shell')), false, '旧误报横幅应消失')
  assert.equal(errs.filter(e => e.includes('WRITE_OWNER')).length, 1, 'WO 留痕应恰一次')
  await out!.app.dispose()
  const errs2: string[] = []
  const oe2 = console.error; console.error = (...a: unknown[]) => { errs2.push(a.join(' ')); oe2(...a) }
  try {
    const app2 = await withBackend('local', () => startRuntime({ configPath: prtsYml, dataRoot: dataRoot(), workspace: ws, mode: 'normal', patches: [{ id: 'llm-deepseek', disabled: true }] }))
    await app2.dispose()
  } finally { console.error = oe2 }
  assert.equal(errs2.filter(e => e.includes('WRITE_OWNER') || e.includes('shell 只读保护')).length, 0, '二次启动不应再打 applied 行')
})

test('T2 local: .git DENY 保护 + 二次启动 already 且无重复 ACE', { timeout: 240000 }, async () => {
  const ws = newWs('t2')
  const head0 = readFileSync(join(ws, '.git', 'HEAD'), 'utf8')
  const sid = workspaceWriteSid(realpathSync.native(ws))
  await withBackend('local', async () => {
    const out = await runOps(ws, [
      'Set-Content .git\\x.txt x', 'Add-Content .git\\HEAD junk', 'Rename-Item .git g2',
      'Get-Content .git\\HEAD', 'Set-Content root.txt ok',
    ], 'local')
    const r = results(await transcript(out.dr))
    assert.match(r[0] ?? '', /访问被拒绝|Access is denied|PermissionDenied/i)
    assert.match(r[1] ?? '', /访问被拒绝|Access is denied|PermissionDenied/i)
    assert.match(r[2] ?? '', /访问被拒绝|Access is denied|PermissionDenied/i)
    assert.match(r[3] ?? '', /ref: refs\/heads/)
    await out.app.dispose()
    assert.equal(readFileSync(join(ws, '.git', 'HEAD'), 'utf8'), head0)
    assert.equal(existsSync(join(ws, '.git', 'x.txt')), false)
    assert.equal(existsSync(join(ws, 'g2')), false)
    assert.equal(existsSync(join(ws, 'root.txt')), true)
    gitCheck(ws)
    // 二次启动：unit 层 already + 结构化读回 DENY 恰好 1 条
    assert.equal(await protectSubpathLocal(ws, '.git'), 'already')
    const n = (await readAcl(join(ws, '.git'))).rules.filter(r => r.type === 1 && r.sid === sid && !r.inherited).length
    assert.equal(n, 1, `显式 DENY 应恰 1 条，实得 ${n}`)
    const errs2: string[] = []
    const oe2 = console.error; console.error = (...a: unknown[]) => { errs2.push(a.join(' ')); oe2(...a) }
    try {
      const app2 = await startRuntime({ configPath: prtsYml, dataRoot: dataRoot(), workspace: ws, mode: 'normal', patches: [{ id: 'llm-deepseek', disabled: true }] })
      await app2.dispose()
    } finally { console.error = oe2 }
    assert.equal(errs2.filter(e => e.includes('shell 只读保护') || e.includes('WRITE_OWNER')).length, 0, '二次启动不应再打 applied 行')
  })
})

test('T3 appcontainer: .git 只读授 RX + 二次启动 already + dispose 后无写允许', { timeout: 300000 }, async () => {
  const ws = newWs('t3')
  const head0 = readFileSync(join(ws, '.git', 'HEAD'), 'utf8')
  await withBackend('appcontainer', async () => {
    const out = await runOps(ws, [
      'Set-Content .git\\x.txt x', 'Add-Content .git\\HEAD junk', 'Rename-Item .git g2',
      'Get-Content .git\\HEAD', 'Set-Content root.txt ok',
    ], 'appcontainer')
    // dispose 必须在 finally：断言失败时若跳过它，持久 pwsh 子进程/管道不会关，
    // 测试文件子进程不退出，全量 runner 会无汇总挂住（本段实测的挂死形态：
    // 测试全部跑完、报告已出、进程不退）。
    try {
      const r = results(await transcript(out.dr))
      assert.match(r[0] ?? '', /访问被拒绝|Access is denied|PermissionDenied/i)
      assert.match(r[1] ?? '', /访问被拒绝|Access is denied|PermissionDenied/i)
      assert.match(r[2] ?? '', /访问被拒绝|Access is denied|exit code: 1/i)
      assert.match(r[3] ?? '', /ref: refs\/heads/)
    } finally {
      await out.app.dispose()
    }
    assert.equal(readFileSync(join(ws, '.git', 'HEAD'), 'utf8'), head0)
    assert.equal(existsSync(join(ws, '.git', 'x.txt')), false)
    gitCheck(ws)
    assert.equal(await protectSubpathAppContainer(ws, '.git', CSID), 'already')
    const snap = await readAcl(join(ws, '.git'))
    assert.equal(snap.rules.some(r => r.sid === CSID && (r.rights & 0x2) !== 0), false, 'dispose 后不应有容器写允许')
    assert.equal(snap.rules.some(r => r.sid === CSID), true, 'RX ACE 仍在（惰性）')
    const errs2: string[] = []
    const oe2 = console.error; console.error = (...a: unknown[]) => { errs2.push(a.join(' ')); oe2(...a) }
    try {
      const app2 = await startRuntime({ configPath: prtsYml, dataRoot: dataRoot(), workspace: ws, mode: 'normal', patches: [{ id: 'llm-deepseek', disabled: true }] })
      await app2.dispose()
    } finally { console.error = oe2 }
    assert.equal(errs2.filter(e => e.includes('shell 只读保护')).length, 0, '二次启动不应再打 applied 行')
  })
})

test('T4 .git 不存在：两后端均 absent 且启动成功', { timeout: 240000 }, async () => {
  const ws = newWs('t4', false)
  assert.equal(await protectSubpathLocal(ws, '.git'), 'absent')
  assert.equal(await protectSubpathAppContainer(ws, '.git', CSID), 'absent')
  await withBackend('local', async () => {
    const app = await startRuntime({ configPath: prtsYml, dataRoot: dataRoot(), workspace: ws, mode: 'normal', patches: [{ id: 'llm-deepseek', disabled: true }] })
    await app.dispose()
  })
})

test('T5 非 win32 返回 skipped', async () => {
  const fake = { platform: 'linux' as NodeJS.Platform }
  assert.equal(await ensureWorkspaceWriteOwner('/x', fake), 'skipped')
  assert.equal(await protectSubpathLocal('/x', '.git', fake), 'skipped')
  assert.equal(await protectSubpathAppContainer('/x', '.git', 'S-1-15-2-1', fake), 'skipped')
})

test('T6 读回不符 throw；startRuntime 对 protect 失败拒绝启动', { timeout: 240000 }, async () => {
  const ws = newWs('t6')
  const alwaysFake = async () => ({ code: 0, out: 'empty acl' })
  await assert.rejects(() => protectSubpathLocal(ws, '.git', { exec: alwaysFake }), (e: Error) => (assert.match(e.message, /\.git/), true))
  // startRuntime 接线：protect 抛错→启动拒绝
  const dr = dataRoot()
  await withBackend('local', () => assert.rejects(
    startRuntime({ configPath: prtsYml, dataRoot: dr, workspace: ws, mode: 'normal', aclOps: { protectLocal: async () => { throw new Error('acl boom') } } }),
    /acl boom|acl/,
  ))
})

test('T-unit ensureWorkspaceWriteOwner: 已有 WO → already', async () => {
  const ws = newWs('tunit', false)
  sh(`icacls "${ws}" /grant *${USER_SID}:(OI)(CI)(WO)`)
  assert.equal(await ensureWorkspaceWriteOwner(ws), 'already')
})

test('T7 WO 授权失败只 warn 不阻断', { timeout: 240000 }, async () => {
  const ws = newWs('t7')
  const warns: string[] = []
  const ow = console.warn; console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); ow(...a) }
  try {
    const app = await withBackend('local', () => startRuntime({
      configPath: prtsYml, dataRoot: dataRoot(), workspace: ws, mode: 'normal',
      patches: [{ id: 'llm-deepseek', disabled: true }],
      aclOps: { ensureWO: async () => { throw new Error('wo denied') } },
    }))
    await app.dispose()
  } finally { console.warn = ow }
  assert.ok(warns.some(w => w.includes('/grant') && w.includes(ws)), `warn 应含 /grant 与路径：${warns.join('|')}`)
})

test('T8 盘符小写传入：SID 仍派生正确，.git 写被拒', { timeout: 240000 }, async () => {
  const wsU = newWs('case')
  const ws = wsU[0].toLowerCase() + wsU.slice(1)
  await withBackend('local', async () => {
    const out = await runOps(ws, ['Set-Content .git\\x.txt x'], 'local')
    results(await transcript(out.dr))
    await out.app.dispose()
  })
  assert.equal(existsSync(join(wsU, '.git', 'x.txt')), false, '小写盘符下 .git 写仍须被拒')
})

test('T9 .git 为 gitfile：两后端保护读回满足 + 内容不可改', { timeout: 300000 }, async () => {
  const wsL = newWs('gf-l', false)
  writeFileSync(join(wsL, '.git'), 'gitdir: C:/prts-test-acl-nowhere/objects\n')
  const wsA = newWs('gf-a', false)
  writeFileSync(join(wsA, '.git'), 'gitdir: C:/prts-test-acl-nowhere/objects\n')
  assert.equal(await protectSubpathLocal(wsL, '.git'), 'applied')
  assert.equal(await protectSubpathAppContainer(wsA, '.git', CSID), 'applied')
  for (const [ws, backend] of [[wsL, 'local'], [wsA, 'appcontainer']] as const) {
    const before = readFileSync(join(ws, '.git'), 'utf8')
    await withBackend(backend, async () => {
      const out = await runOps(ws, ['Set-Content .git x'], backend)
      results(await transcript(out.dr))
      await out.app.dispose()
    })
    assert.equal(readFileSync(join(ws, '.git'), 'utf8'), before, `${backend}：gitfile 内容不应被改`)
  }
})

test('T10 .git 是 junction：两后端 protect 都 throw，目标 ACL 不变', async () => {
  const ws = newWs('junc', false)
  const target = `C:\prts-test-acl-jt-${hex()}`
  mkdirSync(target); created.push(target)
  sh(`cmd /c mklink /J "${join(ws, '.git')}" "${target}"`)
  const snapBefore = await readAcl(target)
  await assert.rejects(() => protectSubpathLocal(ws, '.git'), /reparse|junction|symlink/i)
  await assert.rejects(() => protectSubpathAppContainer(ws, '.git', CSID), /reparse|junction|symlink/i)
  assert.deepEqual(await readAcl(target), snapBefore, 'junction 目标 ACL 不得被改动')
})
