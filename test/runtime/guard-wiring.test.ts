/**
 * K2a 接线回归：模型发起的写调用必须先过 Authority.guard。
 *
 * 两条断言缺一不可——
 *  (a) 越界写：目标在 protectedRoots（dataRoot）内，必须被拒且日志里留下拒绝理由；
 *  (b) 工作区内写：必须放行且内容正确。
 * 只有 (b) 说明不了接线（可能是全拒后测试没暴露），只有 (a) 说明不了判定（可能是全拒）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { runChat } from '../../src/cli/chat.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import type { ScriptedStep } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

/** 读本次会话的 jsonl 全文，用来断言拒绝理由真的落盘。 */
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

/**
 * 等到 transcript 里出现期望的模式再返回。
 * 会话日志落盘晚于工具调用结束，全量并行跑时尤其明显——直接读会拿到空串，
 * 表现为「没有出现拒绝理由」的假失败（单文件跑却是绿的）。
 */
async function transcriptAfter(dataRoot: string, pattern: RegExp, ms = 5000): Promise<string> {
  const t0 = Date.now()
  let out = transcript(dataRoot)
  while (Date.now() - t0 < ms && !pattern.test(out)) {
    await new Promise((r) => setTimeout(r, 50))
    out = transcript(dataRoot)
  }
  return out
}

/** 让模型发起一次 write，返回是否落盘、会话日志、以及落盘时的内容。 */
async function runWrite(where: 'protected' | 'workspace'): Promise<{ created: boolean; log: string; content: string }> {
  const t = makeTmp(`guard-${where}-`)
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })
  const targetPath = where === 'protected' ? join(dataRoot, 'evil.txt') : join(ws, 'ok.txt')

  const app = await startRuntime({
    configPath: prtsYml,
    dataRoot,
    workspace: ws,
    mode: 'normal',
    patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  try {
    const script: ScriptedStep[] = [
      { toolCalls: [{ name: 'write', arguments: { file_path: targetPath, content: 'guard-probe' } }] },
      { text: 'done' },
    ]
    scriptedLlmPlugin(script).apply(app.ctx as Context)
    await runChat({
      ctx: app.ctx as Context,
      lines: lines('write it', '/exit'),
      out: () => {},
      cwd: ws,
      dataRoot,
    })
    const created = existsSync(targetPath)
    return {
      created,
      log: await transcriptAfter(dataRoot, /protected root/),
      content: created ? readFileSync(targetPath, 'utf8') : '',
    }
  } finally {
    await app.dispose()
    t.cleanup()
  }
}

test('guard: 越界写被拒且留理由，工作区内写正常放行', { timeout: 180000 }, async () => {
  const outside = await runWrite('protected')
  const inside = await runWrite('workspace')

  console.log('[guard] protected.created =', outside.created,
    '| 日志含 protected root 理由 =', /protected root/.test(outside.log))
  console.log('[guard] workspace.created =', inside.created,
    '| content =', JSON.stringify(inside.content))

  assert.equal(outside.created, false, '越界写被放行：protectedRoots 内的文件被创建')
  assert.match(outside.log, /protected root/, '会话日志里没有出现来自 guard 的拒绝理由')
  assert.equal(inside.created, true, '工作区内写被误拒')
  assert.equal(inside.content, 'guard-probe', '工作区内写内容不符')
})

/** 读侧：protectedRoots 内的文件不应能被模型读取，内容不得进会话日志。 */
test('guard: 读取 protectedRoots 内的文件被拒且内容不落日志', { timeout: 180000 }, async () => {
  const t = makeTmp('guard-read-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(join(dataRoot, 'secrets'), { recursive: true })
  mkdirSync(ws, { recursive: true })
  const secret = 'SECRET-MUST-NOT-LEAK-9f3a'
  const keyPath = join(dataRoot, 'secrets', 'fake.key')
  writeFileSync(keyPath, secret)

  const app = await startRuntime({
    configPath: prtsYml,
    dataRoot,
    workspace: ws,
    mode: 'normal',
    patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  try {
    const script: ScriptedStep[] = [
      { toolCalls: [{ name: 'read', arguments: { file_path: keyPath } }] },
      { text: 'done' },
    ]
    scriptedLlmPlugin(script).apply(app.ctx as Context)
    await runChat({
      ctx: app.ctx as Context,
      lines: lines('read it', '/exit'),
      out: () => {},
      cwd: ws,
      dataRoot,
    })
    const log = await transcriptAfter(dataRoot, /fs\.read denied/)
    console.log('[guard] 日志含密钥内容 =', log.includes(secret),
      '| 含读拒绝理由 =', /fs\.read denied/.test(log))
    assert.equal(log.includes(secret), false, '受保护文件的内容泄漏进了会话日志')
    assert.match(log, /fs\.read denied/, '没有出现来自 guard 的读拒绝理由')
  } finally {
    await app.dispose()
    t.cleanup()
  }
})
