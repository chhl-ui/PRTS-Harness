# spill 落码计划

设计依据：`docs/design-tool-output-spill.md`（v2，已过议事会四席复评）。实现前先读它。

仓库约定：纯 TypeScript、Node 原生类型剥离直接跑 .ts、只能写可擦除语法（禁 enum / namespace / 参数属性 / `import =` / 装饰器）、本地导入带 `.ts` 后缀、测试用 node:test + node:assert/strict。

TDD 硬性要求：每个 Task 先写会失败的测试（RED），确认它红，再实现到绿（GREEN）。

不许碰：`docs/**`、`src/ledger/**`、`src/audit/**`、`src/sandbox/**`、`node_modules/**`。

### T1: 编码与本地存储

**文件**：`src/spill/types.ts`（新）、`src/spill/encode.ts`（新）、`src/spill/store.ts`（新）、`test/spill/encode.test.ts`（新）、`test/spill/store.test.ts`（新）

**内容**：

`encodeSegment(raw: string): string` —— 注入式路径段编码，移植自 DSH（源码 `C:\Users\Administrator\Desktop\参考库\agent-code\20261029\repos\deepseek-harness\packages\spill\spill-local\src\store.ts`）：
- 空串 → `~`；`.` → `~002E`；`..` → `~002E~002E`
- 其余字符：`[A-Za-z0-9._-]` 且不等于 `~` 时原样保留，否则其 UTF-16 码元转义成 `~XXXX`（大写 hex，padStart(4,'0')）
- 必须注入式：不同输入编码后不同

`src/spill/types.ts` 导出 `SpillSaveInput`（sessionId / toolName / callId / suggestedName / content）、`SpillRef`（locator / bytes / retrievalHint）、`SpillStore`（`saveText(input): Promise<SpillRef>`）。

`src/spill/store.ts` 导出 `createLocalSpillStore(opts: { root: string }): SpillStore`：
- 目录 `<root>/session-<sha256(sessionId) 的 hex 前 16 位>/`
- 文件名 `<12 字节随机 hex>-<encodeSegment(suggestedName)>`
- 先 `mkdir(dir, { recursive: true, mode: 0o700 })`，再校验 dir 不是符号链接/junction（`lstat`），最后 `open(path, 'wx', 0o600)` 写入
- 返回 `{ locator: 绝对路径, bytes: UTF-8 字节数, retrievalHint: 含该路径的说明（提示用 read 或 grep 回读） }`
- 存储失败必须抛错，由调用方降级

**测试用例**：`../x`、`C:\abs\path`、含 `~`、含 NUL、空串、`.`、`..`、中文、emoji（代理对）、两个不同输入不碰撞；正常写入后内容逐字等于输入；bytes 等于 UTF-8 字节数；不同 sessionId 目录不同；同名 suggestedName 两次写入不覆盖；根不存在时自动创建。

**验证**：`node --disable-warning=ExperimentalWarning --test test/spill/encode.test.ts test/spill/store.test.ts` 全绿；`npx tsc -p .` exit 0。

### T2: head-tail 切分（纯函数，不依赖 dsh 类型）

**文件**：`src/spill/retention.ts`（新）、`test/spill/retention.test.ts`（新）

**内容**：只处理最小结构，不 import 任何 `@deepseek-ai/*` 类型。

```ts
export interface RetainedText { head: string; tail: string; omittedBytes: number }
export function retainText(content: string, budgetChars: number): RetainedText
```

规则：head 取 `ceil(budget/2)` 字符、tail 取 `floor(budget/2)` 字符；**不切在 UTF-16 代理对中间**（切点前是 0xD800–0xDBFF 且切点是 0xDC00–0xDFFF 时，head 少切 1、tail 多留 1）；`omittedBytes` = 原文 UTF-8 字节数 − head 字节数 − tail 字节数；`budgetChars <= 0` 时 head 与 tail 都空。

**测试用例**：预算充足时 head+tail 覆盖全文且 omittedBytes 为 0；预算 0；预算 1（head 1 字符、tail 0）；emoji 恰好跨切点（结果不含孤立代理项，`Buffer.from(s,'utf8').toString('utf8')` 往返后等于原串）；中文 omittedBytes 按字节算；原文短于预算。

**验证**：`node --disable-warning=ExperimentalWarning --test test/spill/retention.test.ts` 全绿；`npx tsc -p .` exit 0。

### T3: Authority 增加 spillRoots

**文件**：`src/authority/types.ts`（改）、`src/authority/authority.ts`（改）、`test/authority/spill-roots.test.ts`（新）

**内容**：安全改动，改动面要小。

- `AuthorityConfig` 增加 `spillRoots?: string[]`（可选，缺省按空数组处理，避免破坏现有调用方）
- 构造函数对 `spillRoots` 做 `realpathBestEffort` 归一，与 `workspaceRoots` / `protectedRoots` 同源
- `evalCap` 的 `fs.read` / `fs.write` / `fs.delete` 三处各加一条判定，顺序 **protectedRoots > spillRoots > workspaceRoots**：
  - `fs.read` 在 spillRoots 内 → `{ kind: 'allow', via: 'policy' }`
  - `fs.write` 在 spillRoots 内 → `{ kind: 'deny', reason: 'fs.write denied: <path> is inside spill root' }`
  - `fs.delete` 在 spillRoots 内 → `{ kind: 'deny', reason: 'fs.delete denied: <path> is inside spill root' }`
- 增加只读访问器 `spillRootPaths(): readonly string[]`，返回副本

**测试用例**：T5 模型 read spill 根内文件 → allow；T6 模型 write → deny **且 reason 含 `spill root`**（不能只断 kind，protectedRoots 也能造出 deny）；T6b delete → deny 且 reason 含 `spill root`（`Authority.decide` 是纯函数，可直接构造 capability）；回归：protectedRoots 内 read/write 仍 deny、workspaceRoots 内 write 仍 allow。测试里用注释写清反证：spill 根既不在 protected 也不在 workspace 时，删掉 spillRoots 判定会让 T6 变成 `ask`，所以 T6 断言 deny 能变红。

**验证**：`node --disable-warning=ExperimentalWarning --test test/authority/spill-roots.test.ts` 全绿；`npx tsc -p .` exit 0；`node --disable-warning=ExperimentalWarning --test "test/**/*.test.ts"` 不出现新红。

### T4: 接线（依赖 T1、T2、T3）

**文件**：`src/spill/policy.ts`（新）、`src/runtime/start.ts`（改）、`test/spill/wiring.test.ts`（新）

**内容**：`src/spill/policy.ts` 是纯逻辑，不碰 cordis：

```ts
export interface SpillPolicyDeps {
  store: SpillStore | undefined
  maxInlineTokens: number
  sessionMaxBytes: number
  sessionMaxFiles: number
  warn: (message: string) => void
}
export interface SpillPolicyInput {
  sessionId: string; toolName: string; callId: string
  isError: boolean; text: string
}
export function maybeSpill(deps: SpillPolicyDeps, input: SpillPolicyInput): Promise<{ text: string } | undefined>
```

过滤顺序（设计 §4.3）：store 未启用 → undefined；`isError` → undefined；`toolName === 'read'` → undefined；sessionId 为空 → warn 一次（按 sessionId 去重）并 undefined；估算 token（用 `Math.ceil(text.length / 4)`，不引 dsh-token-meter，理由写注释）≤ maxInlineTokens → undefined；超会话体积/文件数上限 → warn 并 undefined。任何异常 catch → warn → undefined。

替换结果：`head + '\n\n[...]\n\n' + tail + '\n\n[完整结果已存至 <locator>，用 read 或 grep 查看]'`，head/tail 由 `retainText(text, (maxInlineTokens - notice 估算) * 4)` 得到。

`src/runtime/start.ts`：
- 环境变量 `PRTS_SPILL_MAX_INLINE_TOKENS`（默认 8000）、`PRTS_SPILL_SESSION_MAX_BYTES`（默认 64 MiB）、`PRTS_SPILL_SESSION_MAX_FILES`（默认 200）、`PRTS_SPILL_ROOT`（默认 `<dataRoot 的父目录>/prts-spill`）
- 启动自检：spill 根 realpath 归一后与 protectedRoots / workspaceRoots 都不相交；相交则不启用 spill 并 warn，**不阻断启动**
- `Authority.open` 传 `spillRoots: [spillRoot]`
- `ctx.on('tools/post-execute', async (exec, result, next) => {...})`：先 `const decision = await next()`；仅当 `decision.kind === 'accept'` 且不带 `value` 时处理；从 `decision.content ?? result.content` 只抽 `type === 'text'` 的块拼成全文，出现 image 块直接跳过；调 `maybeSpill`；有返回则回 `{ kind: 'accept', content: [{ type: 'text', text }] }`，否则原样返回 decision
- 钩子内全程 try/catch，失败只写 stderr，绝不改变工具调用结果

**测试用例**（`test/spill/wiring.test.ts` 只测 `maybeSpill` 纯逻辑，不起 runtime）：T1 超阈值 + store 可用 → 返回文本含 `[...]` 与 locator，且 locator 指向的文件内容逐字等于原文；T2 注入抛错的 store → undefined 且 warn 被调；T3 toolName='read' → undefined；T4 sessionId='' → undefined 且连调两次 warn 只一次；T4b 超会话上限 → undefined 且不新增文件；isError=true → undefined。

**验证**：`node --disable-warning=ExperimentalWarning --test test/spill/wiring.test.ts` 全绿；`npx tsc -p .` exit 0；`node --disable-warning=ExperimentalWarning --test "test/**/*.test.ts"` 全量不出现新红。
