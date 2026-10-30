// L4 fixture：起一个真实运行时，留一个 started 步骤后被 SIGKILL。
// 用法：node crash-child.ts <dbPath>
import { Ledger } from '../../../src/ledger/index.ts'

const dbPath = process.argv[2]
const owner = { kind: 'owner' } as const

const l = Ledger.open(dbPath)
const t = l.create(owner, { title: 'crash', objective: 'o', acceptance: { kind: 'owner-confirm' } })
const a = l.activate(owner, { id: t.id, revision: t.revision })
l.beginStep(owner, t.id, { stepNo: 1, name: 's1', idempotent: true })
l.endStep(owner, t.id, 1, { status: 'succeeded', outputRef: 'out-1' })
l.beginStep(owner, t.id, { stepNo: 2, name: 's2', idempotent: false })
void a
console.log('READY')
setInterval(() => {}, 1000)
