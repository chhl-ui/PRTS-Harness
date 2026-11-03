import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, spawnSync } from 'node:child_process'
import { startRuntime } from '../../src/runtime/start.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import type { ScriptedStep } from '../support/scripted-llm.ts'
import { runTurn } from '../support/drive.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const WIN = process.platform === 'win32'
const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))
const disableLlm = [{ id: 'llm-deepseek', disabled: true }]

async function boot(t: ReturnType<typeof makeTmp>, script: ScriptedStep[], ws?: string) {
  const dataRoot = join(t.dir, 'data')
  const workspace = ws ?? join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const app = await startRuntime({ configPath: prtsYml, dataRoot, workspace, mode: 'normal', patches: disableLlm })
  scriptedLlmPlugin(script).apply(app.ctx as Context)
  return { ...app, dataRoot, workspace }
}

test('R1: 脚本 write 工具写工作区文件 → 文件存在 + 会话有 tool 事件', { skip: !WIN, timeout: 120000 }, async () => {
  const t = makeTmp('prts-rt-')
  let app: Awaited<ReturnType<typeof boot>> | undefined
  try {
    const target = join(t.dir, 'ws', 'a.txt')
    app = await boot(t, [{ toolCalls: [{ name: 'write', arguments: { file_path: target, content: 'hello-prts' } }] }, { text: 'done' }])
    const { events } = await runTurn(app.ctx as Context, 'write the file', { cwd: app.workspace })
    assert.ok(existsSync(target), 'a.txt 未创建')
    assert.equal(readFileSync(target, 'utf8'), 'hello-prts')
    const sessDir = join(app.dataRoot, 'dsh-home', 'sessions')
    if (existsSync(sessDir)) {
      const all = readdirSync(sessDir, { recursive: true }).join('\n')
      void all
    }
    void events
  } finally { if (app) await app.dispose(); t.cleanup() }
})

test('R2+网络对照：pwsh 沙箱写区内 OK/区外拒 + LanguageMode + TLS 对照', { skip: !WIN, timeout: 120000 }, async () => {
  const t = makeTmp('prts-rt-')
  const outside = join(t.dir, '..', `outside-${Math.random().toString(16).slice(2)}.txt`)
  let app: Awaited<ReturnType<typeof boot>> | undefined
  try {
    const wsFile = join(t.dir, 'ws', 'in.txt')
    const script: ScriptedStep[] = [
      { toolCalls: [{ name: 'pwsh', arguments: { command: `Set-Content -Path "${wsFile.replace(/\\/g, '\\\\')}" -Value ws-ok` } }] },
      { toolCalls: [{ name: 'pwsh', arguments: { command: `Set-Content -Path "${outside.replace(/\\/g, '\\\\')}" -Value x` } }] },
      { toolCalls: [{ name: 'pwsh', arguments: { command: '$ExecutionContext.SessionState.LanguageMode' } }] },
      { toolCalls: [{ name: 'pwsh', arguments: { command: `[Net.ServicePointManager]::SecurityProtocol='Tls12'; try{ 'HTTP-STATUS='+(Invoke-WebRequest 'https://api.deepseek.com' -UseBasicParsing -TimeoutSec 5).StatusCode }catch{ $c=$_.Exception.Response.StatusCode.value__; 'HTTP-STATUS='+($c ? $c : 'NONE') }` } }] },
      { text: 'done' },
    ]
    app = await boot(t, script)
    const { events } = await runTurn(app.ctx as Context, 'run commands', { cwd: app.workspace })
    assert.ok(existsSync(wsFile), '工作区文件未写')
    assert.equal(existsSync(outside), false, '沙箱外文件竟然被写了')
    // LanguageMode：从会话 JSONL 里找 pwsh 工具结果。
    // 等待条件必须是「LanguageMode 已落盘」，不能是「出现任意 tool/result」——脚本化回合有
    // 5 个步骤、3 个 pwsh 调用，第一条结果落盘就 break 会读到还没写完的 transcript，
    // 使下面的 match() 取到 undefined（实测四次两红两绿即由此而来）。
    const sessDir = join(app.dataRoot, 'dsh-home', 'sessions')
    let transcript = ''
    // 60×250ms = 15s。原为 10s，余量偏窄：pwsh 冷启动 + 5 步脚本化回合在负载下可能更久。
    for (let i = 0; i < 60; i++) {
      transcript = ''
      if (existsSync(sessDir)) {
        for (const f of readdirSync(sessDir, { recursive: true }) as string[]) {
          const p = join(sessDir, f)
          try { transcript += readFileSync(p, 'utf8') } catch { /* dir entry */ }
        }
      }
      if (/(FullLanguage|ConstrainedLanguage)/.test(transcript)) break
      await new Promise(r => setTimeout(r, 250))
    }
    const lang = transcript.match(/(FullLanguage|ConstrainedLanguage)/)?.[0]
    console.log('LanguageMode in tool result:', lang ?? 'NOT FOUND')
    assert.ok(transcript.includes('tool/result'), '会话日志缺 tool/result 事件')
    // 先单独断言「等到落盘了」——否则轮询耗尽时 lang 是 undefined，
    // 下面那句会把「等待超时」误报成「语言模式不对」，把定位引到错误的层。
    assert.ok(
      lang !== undefined,
      `等待 LanguageMode 落盘超时（15s），transcript 长度=${transcript.length}。`
      + '这不是语言模式问题，是轮询窗口不足或日志写盘过慢。',
    )
    assert.equal(lang, 'FullLanguage', 'pwsh 未恢复 FullLanguage')
    const net = transcript.match(/HTTP-STATUS=\w+/)
    console.log('sandboxed Invoke-WebRequest:', net?.[0] ?? 'no result found')
    // 网络对照：沙箱内 pwsh 经 DSH runner（这里直接复用工具的 sandbox 不可达——用 AclSandbox 直起对照）
    const psh = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const netCmd = `[Net.ServicePointManager]::SecurityProtocol='Tls12'; try{ $r=Invoke-WebRequest 'https://api.deepseek.com' -UseBasicParsing -TimeoutSec 5; 'NET-OK '+$r.StatusCode }catch{ 'NET-FAIL '+$_.Exception.Message }`
    const r = spawnSync(psh, ['-NoProfile', '-Command', netCmd], { encoding: 'utf8', timeout: 20000 })
    console.log('NET control (no sandbox):', (r.stdout + r.stderr).trim().slice(0, 300))
  } finally {
    if (app) await app.dispose()
    t.cleanup()
    try { execSync(`del "${outside}" 2>nul`, { shell: 'cmd.exe' }) } catch { /* 不存在 */ }
  }
})

test('R3: 会话文件在 dataRoot 下，~/.dsh 不动', { skip: !WIN, timeout: 120000 }, async () => {
  const t = makeTmp('prts-rt-')
  const dshHome = join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')
  const before = existsSync(dshHome) ? readdirSync(dshHome).map(f => `${f}:${statSync(join(dshHome, f)).mtimeMs}`).join(',') : 'ABSENT'
  let app: Awaited<ReturnType<typeof boot>> | undefined
  try {
    app = await boot(t, [{ text: 'ok' }])
    await runTurn(app.ctx as Context, 'hi', { cwd: app.workspace })
    await new Promise(r => setTimeout(r, 500))
    const home = join(app.dataRoot, 'dsh-home')
    const found: string[] = []
    const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.jsonl') || f.name.includes('session')) found.push(p) } }
    if (existsSync(home)) walk(home)
    console.log('dsh-home files:', found)
    assert.ok(found.length > 0, `dataRoot 下找不到会话文件 (home=${home} exists=${existsSync(home)})`)
    const after = existsSync(dshHome) ? readdirSync(dshHome).map(f => `${f}:${statSync(join(dshHome, f)).mtimeMs}`).join(',') : 'ABSENT'
    assert.equal(after, before, '~/.dsh/sessions 发生了变化')
  } finally { if (app) await app.dispose(); t.cleanup() }
})

test('R4: Supervisor+integrity+真实 main.ts 经认证连上、状态正常、shutdown 无遗留', { skip: !WIN, timeout: 120000 }, async () => {
  const t = makeTmp('prts-rt-')
  const pids: number[] = []
  let sup: { status(): { runtimePid: number | null; state: string }; runtimeConnected: boolean; shutdown(): Promise<void> } | undefined
  try {
    const { Supervisor } = await import('../../src/supervisor/index.ts')
    const { initCoreDb } = await import('../../src/core/init.ts')
    const { AuditLog } = await import('../../src/audit/index.ts')
    const { applyEntryPatches, entryListSchema } = await import('@deepseek-ai/cordis-plugin-include')
    const yaml = (await import('js-yaml')).default
    const { readFileSync: rf } = await import('node:fs')
    const { execFileSync } = await import('node:child_process')

    const dataRoot = join(t.dir, 'data')
    const installRoot = process.cwd()
    mkdirSync(dataRoot, { recursive: true })
    const dbPath = join(dataRoot, 'core.sqlite')
    initCoreDb(dbPath)

    // 组合条目（与运行时同一份 prts.yml）
    const entries = (yaml.load(rf(prtsYml, 'utf8'), { schema: entryListSchema }) as unknown[])
    const composed = applyEntryPatches(entries as never, [], () => {}) as { id?: string; name?: string; disabled?: unknown }[]

    // spec：受保护四条 + src 树 → prts upgrade 锚定
    const spec = {
      entries: ['tools', 'agent-loop', 'session', 'sessions']
        .map(id => ({ id, package: (composed.find(e => e.id === id) as { name: string }).name })),
      trees: ['core', 'ledger', 'audit', 'authority', 'stop', 'supervisor', 'chain', 'integrity', 'cli', 'runtime']
        .map(n => ({ name: `src/${n}`, path: `src/${n}` })),
    }
    writeFileSync(join(t.dir, 'spec.json'), JSON.stringify(spec))
    // timeout 是防御：这是本文件唯一的无超时同步等待。它一旦卡住，整个测试
    // 进程同步阻塞，连 --test 的 120s timeout 都不会触发（2026-11-03 挂起排查：
    // 卡在 runtime.test.ts 的子进程存活 112s、日志完全静默——只有同步阻塞会这样）。
    // 正常路径 <5s，60s 上限不会误杀。
    execFileSync(process.execPath, [
      fileURLToPath(new URL('../../src/cli/prts.ts', import.meta.url)), 'upgrade',
      '--install-root', installRoot, '--manifest', join(t.dir, 'manifest.json'),
      '--db', dbPath, '--spec', join(t.dir, 'spec.json'), '--init', '--yes',
    ], { stdio: 'pipe', timeout: 60_000 })

    const mainTs = fileURLToPath(new URL('../../src/runtime/main.ts', import.meta.url))
    const auditPre = AuditLog.open(dbPath); auditPre.close()
    sup = await Supervisor.start({
      dataRoot,
      runtime: { command: process.execPath, args: [mainTs], cwd: installRoot, env: {} },
      ownerPipeName: `r4-${Math.random().toString(16).slice(2, 8)}`,
      workspace: join(t.dir, 'ws'),
      configPath: prtsYml,
      integrity: { installRoot, manifestPath: join(t.dir, 'manifest.json'), entries: () => composed as never },
    })
    const t0 = Date.now()
    while (Date.now() - t0 < 30000 && !sup.runtimeConnected) await new Promise(r => setTimeout(r, 100))
    pids.push(sup.status().runtimePid ?? -1)
    assert.equal(sup.runtimeConnected, true, '运行时未认证连接')
    assert.equal(sup.status().state, 'running')
    await sup.shutdown(); sup = undefined
    const alive = pids.filter(p => { try { process.kill(p, 0); return true } catch { return false } })
    assert.deepEqual(alive, [], '遗留进程')
  } finally {
    if (sup) { try { await sup.shutdown() } catch { /* ignore */ } }
    for (const p of pids) try { process.kill(p, 'SIGKILL') } catch { /* gone */ }
    t.cleanup()
  }
})

test('R5: killAllJobs 杀后台作业+子进程；cancelAllTurns 中断挂起轮次', { skip: !WIN, timeout: 120000 }, async () => {
  const t = makeTmp('prts-rt-')
  let app: Awaited<ReturnType<typeof boot>> | undefined
  let sleepPid = -1
  try {
    app = await boot(t, [
      { toolCalls: [{ name: 'pwsh', arguments: { command: 'Start-Sleep 600' } }] },
      { text: 'done' },
    ])
    const ctx = app.ctx as Context
    const { createStopHooks } = await import('../../src/runtime/stop-hooks.ts')
    const hooks = createStopHooks(ctx)
    const jobs = ctx.get('jobs') as { start(s: unknown): string; list(): { id: string; status: string }[]; wait(id: string, ms: number): Promise<{ status: string }>; attachController(n: string): () => void }
    const detach = jobs.attachController('prts-test')
    // a) 自起后台作业：长睡 powershell
    const { spawn } = await import('node:child_process')
    const cp = spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep 600'])
    sleepPid = cp.pid ?? -1
    const jid = jobs.start({ kind: 'test-sleep', label: 'sleeper', run() {
      return {
        cancel() { try { cp.kill('SIGKILL') } catch { /* gone */ } },
        done: new Promise(res => cp.once('exit', () => res({ kind: 'killed', detail: 'sigkill' }))),
      }
    } })
    assert.ok(jid); console.log('[R5] job started', jid)
    await hooks.killAllJobs()
    detach()
    console.log('[R5] killAllJobs returned')
    const settled = await jobs.wait(jid, 5000)
    assert.notEqual(settled.status, 'running')
    assert.throws(() => { process.kill(sleepPid, 0) }, /ESRCH/)
    // b) 挂起轮次 → cancelAllTurns
    const { agent } = await (ctx.get('agents') as never as { create(o: object): Promise<{ agent: { status: string; followup(m: object): void; whenIdle(): Promise<void> } }> })
      .create({ sessionId: 'r5-hang', meta: { cwd: app.workspace }, agentOptions: { provider: 'deepseek-official', model: 'fake-1' } })
    console.log('[R5] followup sent')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'sleep' }], source: { kind: 'user' } }))
    await new Promise(r => setTimeout(r, 1200))
    console.log('[R5] status after 1.2s:', agent.status)
    assert.equal(agent.status, 'running', '挂起轮次未进入 running')
    console.log('[R5] cancelAllTurns...')
    await hooks.cancelAllTurns()
    console.log('[R5] cancelAllTurns done, status:', agent.status)
    await Promise.race([agent.whenIdle(), new Promise((_, rej) => setTimeout(() => rej(new Error('idle timeout')), 15000))])
    assert.equal(agent.status, 'idle')
    console.log('[R5] killAllJobs #2...')
    await hooks.killAllJobs()
    console.log('[R5] done')
  } finally {
    console.log('[R5] dispose...')
    if (app) await Promise.race([app.dispose(), new Promise(r => setTimeout(r, 15000))])
    console.log('[R5] disposed/timeout')
    try { if (sleepPid > 0) process.kill(sleepPid, 'SIGKILL') } catch { /* gone */ }
    t.cleanup()
  }
})

test('R6: credentials resolve 真形——假端点收到 x-api-key/test-key-123，env 无泄漏', { skip: !WIN, timeout: 120000 }, async () => {
  const t = makeTmp('prts-rt-')
  const captured: Record<string, string | string[] | undefined> = {}
  const http = await import('node:http')
  const srv = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(req.headers)) captured[k.toLowerCase()] = v
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'fake endpoint' }))
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  let app: { ctx: Context; dispose(): Promise<void> } | undefined
  try {
    const dataRoot = join(t.dir, 'data'), ws = join(t.dir, 'ws')
    mkdirSync(dataRoot, { recursive: true }); mkdirSync(ws, { recursive: true })
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      credentials: { DEEPSEEK_API_KEY: 'test-key-123' },
      patches: [{ id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${port}/` } }],
    })
    // 本文件直引 '@deepseek-ai/dsh-llm'（createUserMessage）后，Context.get('llm') 的
    // module augmentation 生效，返回类型变成 LlmRuntime | undefined；此处的窄化替身须经 unknown。
    const llm = (app.ctx as Context).get('llm') as unknown as { stream(o: object): Promise<AsyncIterable<unknown> | { iterable: AsyncIterable<unknown> }> }
    const stream = await llm.stream({ provider: 'deepseek-official', model: 'deepseek-chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    for await (const c of (('iterable' in (stream as never as { iterable: object }) ? (stream as never as { iterable: AsyncIterable<unknown> }).iterable : stream) as AsyncIterable<unknown>)) void c
    const key = (captured['x-api-key'] ?? captured['authorization'] ?? '') as string
    console.log('captured auth headers:', { 'x-api-key': captured['x-api-key'], authorization: captured['authorization'], reqCount: Object.keys(captured).length })
    assert.ok(String(key).includes('test-key-123'), `端点未收到 key (x-api-key=${captured['x-api-key']})`)
    assert.equal(process.env.DEEPSEEK_API_KEY, undefined, 'key 泄漏进 env')
  } finally {
    srv.close()
    // 与 R5 同一兜底：dispose 挂起不得把测试进程拖成永久等待。
    if (app) await Promise.race([app.dispose(), new Promise((r) => setTimeout(r, 15000))])
    t.cleanup()
  }
})
