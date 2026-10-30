import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { treeHash, generateManifest, verifyIntegrity, IntegrityError } from '../../src/integrity/index.ts'
import type { ComposedEntry } from '../../src/integrity/index.ts'
import { initCoreDb } from '../../src/core/init.ts'
import { AuditLog } from '../../src/audit/index.ts'
import { makeTmp } from '../support/tmp.ts'

const cli = fileURLToPath(new URL('../../src/cli/prts.ts', import.meta.url))
const runCli = (args: string[]) => spawnSync(process.execPath, [cli, 'upgrade', ...args], { encoding: 'utf8' })

/** 伪造 installRoot：包 a、b + src/core 树。 */
function fakeRoot(dir: string) {
  const pkg = (name: string, ver: string) => {
    const d = join(dir, 'node_modules', ...name.split('/'))
    mkdirSync(join(d, 'lib'), { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name, version: ver }))
    writeFileSync(join(d, 'lib', 'index.js'), `// ${name}@${ver}\n`)
  }
  pkg('@x/a', '1.0.0'); pkg('@x/b', '2.0.0')
  mkdirSync(join(dir, 'src', 'core'), { recursive: true })
  writeFileSync(join(dir, 'src', 'core', 'init.ts'), 'export {}\n')
}
const SPEC = {
  entries: [{ id: 'tools', package: '@x/a' }, { id: 'session', package: '@x/b' }],
  trees: [{ name: 'core', path: 'src/core' }],
}
const composed = (over: Partial<ComposedEntry>[] = []): ComposedEntry[] => [
  { id: 'tools', name: '@x/a' }, { id: 'session', name: '@x/b' }, ...over as ComposedEntry[],
]

function setup(t: ReturnType<typeof makeTmp>) {
  const root = join(t.dir, 'root')
  mkdirSync(root, { recursive: true })
  fakeRoot(root)
  const manifestPath = join(t.dir, 'manifest.json')
  const db = join(t.dir, 'core.sqlite')
  initCoreDb(db)
  const specPath = join(t.dir, 'spec.json')
  writeFileSync(specPath, JSON.stringify(SPEC))
  return { root, manifestPath, db, specPath }
}
function cliUpgrade(s: ReturnType<typeof setup>, extra: string[] = []) {
  return runCli(['--install-root', s.root, '--manifest', s.manifestPath, '--db', s.db, '--spec', s.specPath, ...extra])
}
const codes = (r: { ok: boolean; failures?: { code: string }[] }) => (r.failures ?? []).map(f => f.code)

test('I1/I2/treeHash/条目侧失败码', () => {
  const t = makeTmp('prts-int-')
  try {
    const s = setup(t)
    const m = generateManifest(s.root, SPEC)
    writeFileSync(s.manifestPath, JSON.stringify(m))
    const base = { installRoot: s.root, manifestPath: s.manifestPath, dbPath: s.db }
    // 未锚定（链中无事件）→ MANIFEST_UNANCHORED
    assert.ok(codes(verifyIntegrity({ ...base, entries: composed() }) as never).includes('MANIFEST_UNANCHORED'))

    // 手动锚定（绕 CLI，直接写事件）
    const a = AuditLog.open(s.db)
    a.append({ kind: 'owner' }, { kind: 'integrity.manifest-updated', oldSha256: null, newSha256: fileHashOf(s.manifestPath), added: [], removed: [], changed: [] })
    a.close()
    let r = verifyIntegrity({ ...base, entries: composed() })
    assert.equal(r.ok, true)

    // TREE_MISMATCH：改包文件一个字节 / 改树文件
    writeFileSync(join(s.root, 'node_modules', '@x', 'a', 'lib', 'index.js'), '// tampered\n')
    r = verifyIntegrity({ ...base, entries: composed() })
    assert.ok((r as { failures: { code: string; detail: string }[] }).failures.some(f => f.code === 'TREE_MISMATCH' && f.detail.includes('@x/a')))
    fakeRoot(s.root) // 复原
    writeFileSync(join(s.root, 'src', 'core', 'init.ts'), 'export {} // x\n')
    r = verifyIntegrity({ ...base, entries: composed() })
    assert.ok((r as { failures: { code: string; detail: string }[] }).failures.some(f => f.code === 'TREE_MISMATCH' && f.detail === 'core'))
    fakeRoot(s.root)

    // disabled 三种形态
    assert.ok(codes(verifyIntegrity({ ...base, entries: [{ id: 'session', name: '@x/b' }] }) as never).includes('ENTRY_MISSING'))
    assert.ok(codes(verifyIntegrity({ ...base, entries: [{ id: 'tools', name: '@x/a', disabled: { __jsExpr: 'false' } }, { id: 'session', name: '@x/b' }] }) as never).includes('ENTRY_DYNAMIC_DISABLED'))
    assert.ok(codes(verifyIntegrity({ ...base, entries: [{ id: 'tools', name: '@x/a', disabled: true }, { id: 'session', name: '@x/b' }] }) as never).includes('ENTRY_DISABLED'))
    assert.equal(verifyIntegrity({ ...base, entries: [{ id: 'tools', name: '@x/a', disabled: false }, { id: 'session', name: '@x/b' }] }).ok, true)
    // 名称不符 / 版本不符 / 重复加载 / 包缺失
    assert.ok(codes(verifyIntegrity({ ...base, entries: [{ id: 'tools', name: '@x/WRONG' }, { id: 'session', name: '@x/b' }] }) as never).includes('ENTRY_NAME_MISMATCH'))
    writeFileSync(join(s.root, 'node_modules', '@x', 'a', 'package.json'), JSON.stringify({ name: '@x/a', version: '9.9.9' }))
    assert.ok(codes(verifyIntegrity({ ...base, entries: composed() }) as never).includes('VERSION_MISMATCH'))
    fakeRoot(s.root)
    assert.ok(codes(verifyIntegrity({ ...base, entries: [...composed(), { id: 'evil', name: '@x/a' }] }) as never).includes('PROTECTED_PACKAGE_DUPLICATED'))
    const t2 = makeTmp('prts-int2-')
    try {
      const s2 = setup(t2)
      const m2 = generateManifest(s2.root, SPEC)
      writeFileSync(s2.manifestPath, JSON.stringify(m2))
      const a2 = AuditLog.open(s2.db)
      a2.append({ kind: 'owner' }, { kind: 'integrity.manifest-updated', oldSha256: null, newSha256: fileHashOf(s2.manifestPath), added: [], removed: [], changed: [] })
      a2.close()
      // junction 进树
      mkdirSync(join(s2.root, 'node_modules', '@x', 'a', 'real'), { recursive: true })
      symlinkSync(join(s2.root, 'node_modules', '@x', 'a', 'real'), join(s2.root, 'node_modules', '@x', 'a', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
      const rr = verifyIntegrity({ installRoot: s2.root, manifestPath: s2.manifestPath, dbPath: s2.db, entries: composed() })
      assert.ok(codes(rr as never).includes('LINK_IN_TREE'))
    } finally { t2.cleanup() }

    // 多错误同列
    const multi = verifyIntegrity({ installRoot: join(s.root, 'NOSUCH'), manifestPath: s.manifestPath, dbPath: s.db, entries: [] })
    const mc = codes(multi as never)
    assert.ok(mc.includes('ENTRY_MISSING') && mc.includes('PACKAGE_MISSING'))

    // treeHash 确定性：不同创建顺序/改 mtime 相同；改内容不同
    const h1 = treeHash(join(s.root, 'node_modules', '@x', 'a'))
    writeFileSync(join(s.root, 'node_modules', '@x', 'a', 'lib', 'z.js'), 'x')
    const h2 = treeHash(join(s.root, 'node_modules', '@x', 'a'))
    assert.notEqual(h1, h2)
    utimesSync(join(s.root, 'node_modules', '@x', 'a', 'lib', 'z.js'), new Date(0), new Date(0))
    assert.equal(treeHash(join(s.root, 'node_modules', '@x', 'a')), h2)
  } finally { t.cleanup() }
})

function fileHashOf(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

test('CLI upgrade：init/锚定/dry-run/二次 init/只读拒绝', () => {
  const t = makeTmp('prts-int-')
  try {
    const s = setup(t)
    // dry-run：无 --yes → exit 2，不写文件
    let r = cliUpgrade(s, ['--init'])
    assert.equal(r.status, 2)
    assert.equal(existsSync(s.manifestPath), false)
    // --init --yes → 写清单+事件 → verify ok
    r = cliUpgrade(s, ['--init', '--yes'])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(existsSync(s.manifestPath))
    assert.equal(verifyIntegrity({ installRoot: s.root, manifestPath: s.manifestPath, dbPath: s.db, entries: composed() }).ok, true)
    // 篡改清单（合法 JSON 改一个 treeSha256）→ MANIFEST_UNANCHORED
    const mm = JSON.parse(readFileSync(s.manifestPath, 'utf8'))
    mm.entries[0].treeSha256 = 'dead'.repeat(16)
    writeFileSync(s.manifestPath, JSON.stringify(mm))
    assert.ok(codes(verifyIntegrity({ installRoot: s.root, manifestPath: s.manifestPath, dbPath: s.db, entries: composed() }) as never).includes('MANIFEST_UNANCHORED'))
    // 已有清单 + --init → 报错
    r = cliUpgrade(s, ['--init', '--yes'])
    assert.notEqual(r.status, 0)
    // 改包内容 + upgrade --yes → changed + 新事件 + verify ok
    writeFileSync(join(s.root, 'node_modules', '@x', 'a', 'lib', 'index.js'), '// v2\n')
    r = cliUpgrade(s, ['--yes'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /changed: entry:tools/)
    const a = AuditLog.open(s.db, { readOnly: true })
    const evs = a.query({ kinds: ['integrity.manifest-updated'] })
    assert.equal(evs.length, 2); a.close()
    assert.equal(verifyIntegrity({ installRoot: s.root, manifestPath: s.manifestPath, dbPath: s.db, entries: composed() }).ok, true)
    // 只读库拒绝
    const raw = new DatabaseSync(s.db)
    raw.exec("UPDATE audit_events SET payload_json='{}' WHERE seq=1")
    raw.close()
    r = cliUpgrade(s, ['--yes'])
    assert.equal(r.status, 3)
    assert.match(r.stderr, /read-only/)
  } finally { t.cleanup() }
})

test('Supervisor 完整性：失败不启动运行时+审计 ok:false；成功正常启动+ok:true', { skip: process.platform !== 'win32' }, async () => {
  const { Supervisor } = await import('../../src/supervisor/index.ts')
  const { owner } = await import('../ledger/helpers.ts')
  const { Ledger } = await import('../../src/ledger/index.ts')
  void owner; void Ledger
  const fixture = fileURLToPath(new URL('../supervisor/fixtures/fake-runtime.ts', import.meta.url))
  const t = makeTmp('prts-int-')
  let sup: Awaited<ReturnType<typeof Supervisor.start>> | undefined
  try {
    const s = setup(t)
    // 失败路径：清单不存在 → INTEGRITY_FAILED，无运行时
    const cfg = (ok: boolean) => ({
      dataRoot: join(t.dir, ok ? 'ok' : 'bad'),
      runtime: { command: process.execPath, args: [fixture], cwd: join(t.dir, 'root'), env: { PRTS_DATA_ROOT: join(t.dir, ok ? 'ok' : 'bad') } },
      ownerPipeName: `int-${Math.random().toString(16).slice(2, 8)}`,
      integrity: { installRoot: s.root, manifestPath: ok ? s.manifestPath : join(t.dir, 'nonexistent.json'), entries: () => composed() },
    })
    mkdirSync(join(t.dir, 'bad'), { recursive: true })
    await assert.rejects(
      Supervisor.start(cfg(false)),
      (e: unknown) => (e as { code?: string }).code === 'INTEGRITY_FAILED',
    )
    const alerts = readFileSync(join(t.dir, 'bad', 'logs', 'alerts.log'), 'utf8')
    assert.match(alerts, /MANIFEST_UNANCHORED|integrity/)
    const badDb = new DatabaseSync(join(t.dir, 'bad', 'core.sqlite'))
    const cnt = (badDb.prepare("SELECT COUNT(*) c FROM audit_events WHERE kind='integrity.checked'").get() as { c: number }).c
    badDb.close()
    assert.ok(cnt >= 1)

    // 成功路径：锚定清单 → 运行时启动 + ok:true
    cliUpgrade(s, ['--init', '--yes'])
    mkdirSync(join(t.dir, 'ok'), { recursive: true })
    const okDbPath = join(t.dir, 'ok', 'core.sqlite')
    initCoreDb(okDbPath)
    const anchor = AuditLog.open(okDbPath)
    anchor.append({ kind: 'owner' }, { kind: 'integrity.manifest-updated', oldSha256: null, newSha256: fileHashOf(s.manifestPath), added: [], removed: [], changed: [] })
    anchor.close()
    sup = await Supervisor.start(cfg(true))
    const t0 = Date.now()
    while (Date.now() - t0 < 8000 && sup.status().runtimePid === null) await new Promise(r => setTimeout(r, 50))
    assert.ok(sup.status().runtimePid !== null, '运行时未启动')
    const okDb = new DatabaseSync(okDbPath)
    const okCnt = (okDb.prepare("SELECT COUNT(*) c FROM audit_events WHERE kind='integrity.checked' AND payload_json LIKE '%\"ok\":true%'").get() as { c: number }).c
    okDb.close()
    assert.ok(okCnt >= 1)
  } finally {
    if (sup) { try { await sup.shutdown() } catch { /* ignore */ } }
    t.cleanup()
  }
})
