/**
 * K2b 第一刀：net 守卫。
 *
 * K2a 只把 `fs.read/write/delete` 三类送进 `authority.guard`——`start.ts` 的 guard 里
 * 有一行显式 `filter`，非 fs 能力直接 return undefined（放行）。所以 `net` 虽然在
 * `Authority.evalCap` 里有分支（无 grant 即 ask），**实际永远不会被调用到**：
 * classify 从不产生 net 能力。
 *
 * 本刀只补 net，不动 exec / tool：`pwsh` 进 ask 会让 runtime.test.ts 的 R2 必红，
 * 而且命令体内的写删识别不了，整体拒绝不是真边界（AGENTS.md K6 已记）。
 *
 * 为什么 net 的价值在于「默认 ask」而不是「默认 deny」：联网本身不是越权，
 * 但它是**数据出境**动作——记忆库里的对话内容可以被一次 fetch 带走。所以要求每次
 * （或按 host 授权）经人点头，而不是静默放行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Authority, cap, classify } from '../../src/authority/index.ts'
import { makeTmp } from '../support/tmp.ts'

const call = (caps: string[]) => ({ sessionId: 's1', callId: 'c1', tool: 'x', capabilities: caps })

test('K1 网络类工具归到 net，并尽力从参数里提取 host', () => {
  assert.deepEqual(classify('web_search', { query: '量子计算' }), [cap.net('*')], '没有 URL 参数时用 * 兜底')
  assert.deepEqual(classify('fetch', { url: 'https://example.com/a?b=1' }), [cap.net('example.com')])
  assert.deepEqual(classify('browser_open', { url: 'http://a.b:8080/x' }), [cap.net('a.b')], '端口不该进 host')
  assert.deepEqual(classify('http_request', { endpoint: 'https://api.deepseek.com/v1' }), [cap.net('api.deepseek.com')])
})

test('K2 非网络工具分类一个字节都不变（fs / pwsh / 普通工具）', () => {
  // 路径会被 normalizePath 补成盘符绝对路径（Windows 下 /tmp/x → C:\tmp\x），
  // 所以只断言能力类别，不硬比路径字符串。
  assert.ok(classify('read', { file_path: '/tmp/x' })[0].startsWith('fs.read:'), 'read 仍是 fs.read')
  assert.deepEqual(classify('write', { file_path: '/tmp/y' })[0].slice(0, 9), 'fs.write:', 'write 仍是 fs.write')
  assert.deepEqual(classify('pwsh', { command: 'ls' }), [cap.execShell()], 'pwsh 仍是 exec，不进 net')
  assert.deepEqual(classify('prts_memory_recall', {}), [cap.tool('prts_memory_recall')])
  assert.deepEqual(classify('working_directory', {}), [])
})

test('K3 无 grant 的 net 一律 ask；按 host 授权后才 allow', () => {
  const t = makeTmp('prts-k2b-')
  const a = Authority.open(t.db(), { workspaceRoots: [t.dir], protectedRoots: [] })
  try {
    const d = a.decide(call([cap.net('example.com')]))
    assert.equal(d.kind, 'ask', '联网是数据出境动作，没有授权必须问人，不能静默放行')

    a.issueGrant({ subject: 'model', capability: cap.net('example.com'), expiresAt: null })
    assert.equal(a.decide(call([cap.net('example.com')])).kind, 'allow', '授权后放行')
    assert.equal(a.decide(call([cap.net('other.com')])).kind, 'ask', '授权按 host 生效，不能串到别的域名')
  } finally { a.close(); t.cleanup() }
})

test('K4 net 与 fs 混合能力时，任一被拒即整体拒绝（不因多能力而放水）', () => {
  const t = makeTmp('prts-k2b-')
  const prot = `${t.dir}-protected`
  const a = Authority.open(t.db(), { workspaceRoots: [t.dir], protectedRoots: [prot] })
  try {
    const d = a.guard({
      sessionId: 's1', callId: 'c1', tool: 'x',
      capabilities: [cap.net('example.com'), cap.fsWrite(`${prot}/secret.txt`)],
    })
    assert.equal(typeof d, 'string', '受保护路径被拒时，即使 net 也没法把整次调用带过去')
  } finally { a.close(); t.cleanup() }
})
