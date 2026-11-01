/**
 * E3 审批回归：越界操作先问人，批准才执行。
 *
 * 三层授权语义（探针实测，authority.decide 的 deny > ask > allow）：
 *  - protectedRoots 内   → deny，绝对禁止，审批救不了
 *  - 工作区外、非 protected → ask，走审批（本文件的主角）
 *  - 工作区内           → allow，不问
 *
 * 四条断言缺一不可：只有「批准→执行」说明不了审批接线（可能是全放行），
 * 只有「拒绝→不执行」也说明不了（可能是全拒）。两个回归场景防止把边界改坏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { runChat } from '../../src/cli/chat.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { prtsYml, PATCHES } from '../support/composition.ts'
import { makeTmp } from '../support/tmp.ts'

// prtsYml 与 patches 统一来自 test/support/composition.ts——与管道用例共用同一组
// 组装参数，否则「审批在管道入口下可达」只能靠人读两个文件比对。

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

/** 读本次会话的 jsonl 全文，用来断言审批事件真的落盘。 */
function transcript(dataRoot: string): string {
  const root = join(dataRoot, 'dsh-home', 'sessions')
  if (!existsSync(root)) return ''
  let out = ''
  for (const f of readdirSync(root, { recursive: true }) as string[]) {
    const p = join(root, f)
    if (!p.endsWith('.jsonl')) continue
    try { out += readFileSync(p, 'utf8') } catch { /* 目录项 */ }
  }
  return out
}

/** 会话日志落盘晚于工具结束，轮询到出现期望模式为止。 */
async function transcriptAfter(dataRoot: string, pattern: RegExp, ms = 5000): Promise<string> {
  const t0 = Date.now()
  let out = transcript(dataRoot)
  while (Date.now() - t0 < ms && !pattern.test(out)) {
    await new Promise((r) => setTimeout(r, 50))
    out = transcript(dataRoot)
  }
  return out
}

type Where = 'outside' | 'workspace' | 'protected'

interface RunResult {
  created: boolean
  content: string
  prompt: string
  log: string
}

/** 让模型发起一次 write，按 answer 应答审批（无审批时该行不会被消费）。 */
async function runWrite(where: Where, answer: 'y' | 'n' | null): Promise<RunResult> {
  const t = makeTmp(`e3-${where}-`)
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  const outside = join(t.dir, 'outside')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const target = where === 'protected'
    ? join(dataRoot, 'evil.txt')
    : where === 'workspace'
      ? join(ws, 'ok.txt')
      : join(outside, 'approved.txt')

  const app = await startRuntime({
    configPath: prtsYml,
    dataRoot,
    workspace: ws,
    mode: 'normal',
    patches: PATCHES,
  })
  const chunks: string[] = []
  try {
    scriptedLlmPlugin([
      { toolCalls: [{ name: 'write', arguments: { file_path: target, content: 'e3-payload' } }] },
      { text: 'done' },
    ]).apply(app.ctx)

    const inputs = answer === null ? ['write it', '/exit'] : ['write it', answer, '/exit']
    await runChat({
      ctx: app.ctx,
      lines: lines(...inputs),
      out: (text) => chunks.push(text),
      cwd: ws,
      dataRoot,
      ledger: app.ledger,
      authority: app.authority,
      approvalBridge: app.approvalBridge,
    })

    const created = existsSync(target)
    return {
      created,
      content: created ? readFileSync(target, 'utf8') : '',
      prompt: chunks.join(''),
      log: await transcriptAfter(dataRoot, /approval\/(asked|decided)/),
    }
  } finally {
    await app.dispose()
    t.cleanup()
  }
}

test('E3: 工作区外写 → 审批提示 → 批准 → 文件落盘', { timeout: 180000 }, async () => {
  const r = await runWrite('outside', 'y')
  console.log('[e3] approve.created =', r.created,
    '| 有审批提示 =', r.prompt.includes('[审批]'),
    '| 日志有 asked =', /approval\/asked/.test(r.log))

  assert.match(r.prompt, /\[审批\] 工具 write 请求越界操作/, '终端没有出现审批提示')
  assert.equal(r.created, true, '已批准但文件未落盘——once 记录未被 guard 认可')
  assert.equal(r.content, 'e3-payload', '内容不符')
  assert.match(r.log, /approval\/asked/, '审计里没有 approval/asked')
  assert.match(r.log, /approval\/decided/, '审计里没有 approval/decided')
})

test('E3: 工作区外写 → 审批提示 → 拒绝 → 文件不落盘', { timeout: 180000 }, async () => {
  const r = await runWrite('outside', 'n')
  console.log('[e3] reject.created =', r.created,
    '| 有审批提示 =', r.prompt.includes('[审批]'),
    '| 日志有 decided =', /approval\/decided/.test(r.log))

  assert.match(r.prompt, /\[审批\] 工具 write 请求越界操作/, '终端没有出现审批提示')
  assert.equal(r.created, false, '已拒绝但文件仍被创建')
  assert.match(r.log, /approval\/decided/, '拒绝没有写入 approval/decided 审计')
})

test('回归: 工作区内写不问审批，直接落盘', { timeout: 180000 }, async () => {
  const r = await runWrite('workspace', null)
  console.log('[e3] workspace.created =', r.created, '| 有审批提示 =', r.prompt.includes('[审批]'))

  assert.equal(r.prompt.includes('[审批]'), false, '工作区内写不该弹审批')
  assert.equal(r.created, true, '工作区内写被误拒')
})

test('回归: protectedRoots 内写不弹审批，直接拒绝', { timeout: 180000 }, async () => {
  const r = await runWrite('protected', null)
  console.log('[e3] protected.created =', r.created,
    '| 有审批提示 =', r.prompt.includes('[审批]'),
    '| 日志含 protected root 理由 =', /protected root/.test(r.log))

  assert.equal(r.prompt.includes('[审批]'), false,
    'protectedRoots 不该走审批——decide 的 deny 优先于 ask')
  assert.equal(r.created, false, 'protectedRoots 内的写被放行')
  assert.match(r.log, /protected root/, '没有出现来自 guard 的 protected root 拒绝理由')
})
