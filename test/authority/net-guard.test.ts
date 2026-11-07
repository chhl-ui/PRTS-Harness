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

test('K1b 第三方代理工具按真实出站 host 授权，不按参数里的目标站点', () => {
  // prts_web_* 的代码跑在本进程里，但真正被连接的是 Firecrawl。参数里的 url 只是
  // 「要它替你抓哪个站」，本机的网络边界是 api.firecrawl.dev——按目标站授权会让
  // prts_web_search（参数里根本没有 url）退化成 net:*，白名单永远命不中。
  assert.deepEqual(classify('prts_web_search', { query: '量子计算' }), [cap.net('api.firecrawl.dev')])
  assert.deepEqual(classify('prts_web_fetch', { url: 'https://evil.example/x' }), [cap.net('api.firecrawl.dev')])
  // 未登记的工具仍按参数推 host，行为不变
  assert.deepEqual(classify('web_search', { query: 'x' }), [cap.net('*')])
})

test('K1c 白名单配 api.firecrawl.dev 后，两个联网工具都直接放行，不弹审批', () => {
  const t = makeTmp('prts-k2b-')
  const a = Authority.open(t.db(), {
    workspaceRoots: [t.dir], protectedRoots: [], netAllowHosts: ['api.firecrawl.dev'],
  })
  try {
    for (const [tool, args] of [
      ['prts_web_search', { query: 'q' }],
      ['prts_web_fetch', { url: 'https://example.com' }],
    ] as const) {
      assert.equal(a.decide(call(classify(tool, args))).kind, 'allow', `${tool} 应被白名单放行`)
    }
    // 白名单只覆盖 Firecrawl，不放行任意站点
    assert.equal(a.decide(call([cap.net('example.com')])).kind, 'ask', '别的域名仍要授权')
  } finally { a.close(); t.cleanup() }
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

// ---- 白名单：把「每次都问」换成「常用域名一次配置」----

const callNet = (host: string) => ({ sessionId: 's1', callId: 'c1', tool: 'fetch', capabilities: [cap.net(host)] })

test('K5 白名单内的 host 直接 allow，不再逐次打断', () => {
  const t = makeTmp('prts-k2b-')
  const a = Authority.open(t.db(), {
    workspaceRoots: [t.dir], protectedRoots: [],
    netAllowHosts: ['api.deepseek.com', '*.githubusercontent.com'],
  })
  try {
    assert.equal(a.decide(callNet('api.deepseek.com')).kind, 'allow', '白名单精确命中')
    assert.equal(a.decide(callNet('raw.githubusercontent.com')).kind, 'allow', '通配符匹配子域')
    assert.equal(a.decide(callNet('a.b.githubusercontent.com')).kind, 'allow', '通配符匹配多级子域')
  } finally { a.close(); t.cleanup() }
})

test('K6 白名单外仍然 ask；通配符不能越界匹配', () => {
  const t = makeTmp('prts-k2b-')
  const a = Authority.open(t.db(), {
    workspaceRoots: [t.dir], protectedRoots: [],
    netAllowHosts: ['*.githubusercontent.com'],
  })
  try {
    assert.equal(a.decide(callNet('example.com')).kind, 'ask', '白名单外必须问人')
    assert.equal(a.decide(callNet('githubusercontent.com')).kind, 'ask', '裸域不等于 *.子域')
    assert.equal(a.decide(callNet('evilgithubusercontent.com')).kind, 'ask', '后缀不能被子串蒙混')
    assert.equal(a.decide(callNet('*')).kind, 'ask', '未知 host 仍走 ask')
  } finally { a.close(); t.cleanup() }
})

test('K7 未配置白名单时行为与改动前一致（空数组 = 全部 ask）', () => {
  const t = makeTmp('prts-k2b-')
  const a = Authority.open(t.db(), { workspaceRoots: [t.dir], protectedRoots: [] })
  try {
    assert.equal(a.decide(callNet('api.deepseek.com')).kind, 'ask')
  } finally { a.close(); t.cleanup() }
})
