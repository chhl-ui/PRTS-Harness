/**
 * 子会话（subagent）的权限边界：三条测试。
 *
 * 存在理由：`docs/design-superagent-fusion.md` 第三节原先断言「权限不继承，按 sessionId 查
 * grant/once」——议事会指出这与代码相反，核实属实。这里把边界钉住，让实现收窄后的翻转点
 * 有据可查。
 *
 * 收窄后的代码事实（本文件断言的对象）：
 * - `audit_grants` 有 `session_id`（`src/audit/audit.ts` 的 SCHEMA + 幂等迁移）；
 *   `listGrants()` 带出 `sessionId`
 * - `validGrants()` 保留 `sessionId`，`grantsForSession(sessionId)` 只放行
 *   「全局授予（sessionId=null）」与「本会话授予」，`evalCap` 的 fs.write / net / exec / tool
 *   四族共用这一份过滤，没有哪一族能绕开
 * - `once` 按 `callId + sessionId` 消费（父会话的批准换会话即失效）
 * - **未收窄**：工作区内 fs.write 仍走 `via:'policy'` 无条件放行，与 sessionId 无关。
 *   这条路不是「继承」——它对所有会话（包括主会话）一视同仁。要收窄它需要「谁是子会话」
 *   的注册信息，那是 W2 `prts_subtask` 的会话级 workspace 收窄，不属于 grant 会话归属。
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

test('子会话权限①：父会话的会话绑定 grant 不传给子会话，子会话必须重新问人', async () => {
  await withAuth(({ auth, outside }) => {
    const target = join(outside, 'note.txt')
    // 父会话在工作区之外拿到一条持久写授权，归属钉在父会话上
    const grantId = auth.issueGrant({
      subject: 'model',
      capability: `fs.write:${outside}` as never,
      expiresAt: null,
      sessionId: 'parent-router',
    })
    assert.ok(grantId.length > 0, 'grant 必须真的发出去')

    const parent = auth.guard({
      sessionId: 'parent-router',
      callId: 'call-parent-1',
      tool: 'write',
      capabilities: [`fs.write:${target}` as never],
    })
    assert.equal(parent, undefined, '基线：父会话凭自己的 grant 放行')

    const childCall = {
      sessionId: 'child-worker-1',
      callId: 'call-child-1',
      tool: 'write',
      capabilities: [`fs.write:${target}` as never],
    }
    // 收窄后：grant 的 sessionId ≠ 调用方会话 → 不 covered → 回到 ask（要人点头），不是 allow。
    assert.equal(auth.decide(childCall).kind, 'ask', '子会话不该凭父会话的 grant 放行')
    assert.equal(typeof auth.guard(childCall), 'string', '守卫必须拒绝并返回理由串')
  })
})

test('子会话权限②：无 once 时默认 ask（不覆盖 once 跨会话场景）', async () => {
  await withAuth(({ auth, outside }) => {
    const target = join(outside, 'note2.txt')
    // 本条只证明「没有 grant、没有 once 时不放行」。
    // once 的跨会话问题由 test/authority/session-scope.test.ts 的 S2/S4 覆盖（decide 已比
    // `call.sessionId`，空会话一律不 covered）。
    const childNoOnce = auth.decide({
      sessionId: 'child-worker-2',
      callId: 'call-child-2',
      tool: 'write',
      capabilities: [`fs.write:${target}` as never],
    })
    assert.equal(childNoOnce.kind, 'ask', '没有 once 时应当是 ask，不是 allow')
  })
})

test('子会话权限③：工作区内 fs.write 仍是 policy 放行（残留缺口，属 W2 会话级 workspace 收窄）', async () => {
  await withAuth(({ auth, ws }) => {
    const target = join(ws, 'shared.txt')
    const decision = auth.decide({
      sessionId: 'child-worker-3',
      callId: 'call-child-3',
      tool: 'write',
      capabilities: [`fs.write:${target}` as never],
    })
    // 现状：workspaceRoots 命中 → allow via policy，与 sessionId 无关。
    // 这说明「给 grant 加会话归属」不足以让子会话失去工作区写权限——policy 那条路根本
    // 不查 grant。收窄它需要「谁是子会话」的注册信息（W2 `prts_subtask` 派生时收窄
    // 子会话的 workspaceRoots），届时本断言翻转为 deny。
    assert.equal(decision.kind, 'allow', '现状记录：工作区内写入放行')
    assert.equal((decision as { via?: string }).via, 'policy', '放行通道是 policy，不是 grant')
  })
})
