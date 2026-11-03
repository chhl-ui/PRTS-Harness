/**
 * 子会话（subagent）的权限边界：三条负向测试。
 *
 * 存在理由：`docs/design-superagent-fusion.md` 第三节原先断言「权限不继承，按 sessionId 查
 * grant/once」——议事会指出这与代码相反，核实属实。这里把**现状**钉住，让它无法再被口头
 * 误判，也让 W2 实现收窄能力时的翻转点明确可查。
 *
 * 代码事实（本文件断言的对象）：
 * - `validGrants()` = `audit.listGrants()` 过滤撤销/过期后 `map`，**丢掉 `subject`**（authority.ts:105-111）
 * - `evalCap` 只按 `g.capability` 匹配，不看 subject / sessionId（:157 / :182 / :188）
 * - 工作区内 fs.write 走 `via:'policy'` 无条件放行，连 grant 都不需要（:150-155）
 * - `once` 按 `call.callId` 消费（:206），callId 每次调用唯一 → 这条确实不跨会话继承
 *
 * 三个用例的性质：
 *   1、3 是**特性化测试**（记录现状缺陷）。W2 落地收窄能力后它们必须翻转为 deny 断言；
 *      在那之前它们绿，不表示安全，只表示「缺陷与文档描述一致」。
 *   2 是**正确行为**的守护测试，不该翻转。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { Authority } from '../../src/authority/authority.ts'
import { makeTmp } from '../support/tmp.ts'

/** 与 authority 同源的真实路径规范化：两侧都用 realpath，否则比较域不一致会产生假阴性。 */
const rp = (p: string): string => realpathSync.native(p)

async function withAuth(fn: (ctx: { auth: Authority; ws: string; outside: string; dataRoot: string }) => void): Promise<void> {
  const t = makeTmp('prts-subauth-')
  const ws = join(t.dir, 'ws')
  const outside = join(t.dir, 'outside')
  const dataRoot = join(t.dir, 'data')
  mkdirSync(ws, { recursive: true })
  mkdirSync(outside, { recursive: true })
  mkdirSync(dataRoot, { recursive: true })
  const auth = Authority.open(join(t.dir, 'core.sqlite'), {
    workspaceRoots: [rp(ws)],
    protectedRoots: [rp(dataRoot)],
  })
  try {
    fn({ auth, ws: rp(ws), outside: rp(outside), dataRoot: rp(dataRoot) })
  } finally {
    auth.close()
    t.cleanup()
  }
}

test('子会话权限①：父会话的持久 grant 会被子会话继承（现状，W2 必须翻转为拒绝）', async () => {
  await withAuth(({ auth, outside }) => {
    const target = join(outside, 'note.txt')
    // 父会话在工作区之外拿到一条持久写授权
    const grantId = auth.issueGrant({
      subject: 'model',
      capability: `fs.write:${outside}` as never,
      expiresAt: null,
    })
    assert.ok(grantId.length > 0, 'grant 必须真的发出去')

    const parent = auth.guard({
      sessionId: 'parent-router',
      callId: 'call-parent-1',
      tool: 'write',
      capabilities: [`fs.write:${target}` as never],
    })
    assert.equal(parent, undefined, '基线：父会话凭 grant 放行')

    const child = auth.guard({
      sessionId: 'child-worker-1',
      callId: 'call-child-1',
      tool: 'write',
      capabilities: [`fs.write:${target}` as never],
    })
    // 现状：grant 无 subject 过滤 → 子会话同样放行。
    // W2 收窄后本行必须改成 assert.notEqual(child, undefined)。
    assert.equal(child, undefined, '现状记录：子会话静默继承了父会话的持久 grant')
  })
})

test('子会话权限②：无 once 时默认 ask（不覆盖 once 跨会话场景）', async () => {
  await withAuth(({ auth, outside }) => {
    const target = join(outside, 'note2.txt')
    // 本条只证明「没有 grant、没有 once 时不放行」。
    // **未覆盖**：父会话拿到 once 后，子会话用另一个 callId 能否消费——那需要构造
    // approval.decided 事件流（audit_once 由 fold 写），成本高且与 W2 的收窄设计无直接关系。
    // 代码事实（authority.ts:206 `getOnce(call.callId)`）表明 once 按 callId 消费、callId
    // 每次调用唯一，故推断不跨会话——**这是读码推断，不是本条实测的结论**。
    const childNoOnce = auth.decide({
      sessionId: 'child-worker-2',
      callId: 'call-child-2',
      tool: 'write',
      capabilities: [`fs.write:${target}` as never],
    })
    assert.equal(childNoOnce.kind, 'ask', '没有 once 时应当是 ask，不是 allow')
  })
})

test('子会话权限③：工作区内 fs.write 对所有会话走 via:policy 放行（现状，W2 必须收窄）', async () => {
  await withAuth(({ auth, ws }) => {
    const target = join(ws, 'shared.txt')
    const decision = auth.decide({
      sessionId: 'child-worker-3',
      callId: 'call-child-3',
      tool: 'write',
      capabilities: [`fs.write:${target}` as never],
    })
    // 现状：workspaceRoots 命中 → allow via policy，与 sessionId 无关。
    // 这说明「给 grant 加 subject 过滤」不足以让子会话失去写权限——policy 那条路绕开了 grant。
    assert.equal(decision.kind, 'allow', '现状记录：工作区内写入放行')
    assert.equal((decision as { via?: string }).via, 'policy', '放行通道是 policy，不是 grant')
  })
})
