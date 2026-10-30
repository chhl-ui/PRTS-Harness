# prts-system

PRTS（Primitive Rhodes Island Terminal Service）受保护核心的首个组件：K1「任务账本」。
纯 TypeScript 库，`node:sqlite` 持久化，只追加哈希链事件 + 可重建投影。暂不接 DSH/Cordis。

## 命令

```sh
npm install        # 仅 devDependency: typescript
npm test           # node --test（node:test + assert/strict）
npm run typecheck  # tsc -p .（strict + erasableSyntaxOnly + noEmit）
```

## 语法约束（Node 原生类型剥离直接运行 .ts）

- 只用可擦除语法：不要 `enum`、`namespace`、参数属性、`import =`、装饰器。
- tsconfig 已开 `erasableSyntaxOnly`、`allowImportingTsExtensions`、`noEmit`、`strict`、`nodenext`。
- 本地导入一律带 `.ts` 后缀。
- Node 类型由 `@types/node`（devDependency，主版本 24）提供；tsconfig 已设 `"types": ["node"]`。

## 固定 actor 通道契约

`verify / ownerAccept / ownerReject / setBudget / stopByOwner / resumeFromStop / chargeUsage / recoverOnStartup`
的 actor 由库内固定，属于所有者/系统通道。面向模型的工具适配层必须把传入 actor 固定为
`{ kind: 'model', sessionId }`，且不得暴露上述方法；本库不验证 actor 的真实来源。

## 工作方式

- 先写失败测试，再实现。测试用 `os.tmpdir()` 下独立临时目录，结束删除。
- 数据规则：`ledger_events` / `audit_events` 各自是事实来源（只追加、sha256 链）；
  `tasks`/`task_steps`/`evidence` 只能由 `fold.ts` 的 `applyEvent` 更新，
  `audit_deletions` 只能由 `audit/fold.ts` 的 `applyAuditEvent` 更新；
  每个变更在一个 SQLite 事务内「追加事件 + 应用投影」。
- 共享链原语在 `src/chain/`（canonicalJson/sha256hex/ZERO_HASH + chainHash/appendChained/verifyChainRows）；
  新组件复用它，不要各自实现哈希链。
- K4 审计：`src/audit/`（同一 SQLite 文件、独立表独立链）；`deletion.completed` 只允许库内部
  在最后一个派生项完成的同事务自动追加；`src/core/startup-check.ts` 用只读连接双链校验。
- Ledger/AuditLog 均支持 `{ readOnly: true }` 打开：所有写方法抛 `READ_ONLY`。
- 运行时启动顺序：`startupCheck` → 正常则 `initCoreDb` → 打开 Ledger/AuditLog；
  `startupCheck` 返回 `read-only`（断链或缺表）时不得调用 `initCoreDb`，只能只读打开。
- K2a 授权（`src/authority/`）：`Authority.guard(call)` 与 DSH `tools.guard` 同签名（同步、
  返回理由串即拒绝）——**守卫是唯一强制点**，pre-execute 瀑布与审批应答可被前置插件伪造；
  decide 每次直查 SQLite（无进程内缓存），跨进程撤销即时生效。
  pwsh 命令体内的写/删操作守卫无法识别，shell 写入范围留待 K2b 沙箱处理。
- K3 停止权与守护进程（`src/stop/`、`src/supervisor/`，仅 Windows）：
  `StopController` 执行运行时内分级停止；`Supervisor` 在进程外把运行时放进
  kill-on-close Job，S0–S2 经控制管道转发、超时升级 S3 强杀整树；
  运行时意外退出按限额自动重启。**所有者命名管道只接受 `stop` 和 `status`**，
  其他消息一律 `UNSUPPORTED`，畸形 JSON 不崩守护进程。
  控制管道连接须 2s 内发送 `{type:'hello',pid,token}` 认证（token 每次重启换新、
  timingSafeEqual 比对、pid 必须等于 Job 内运行时 pid，先认证者胜）；
  **真实运行时必须在派生任何子进程之前调用 `connectControl`**（读 env 即删），
  防止模型 shell 经继承的 `PRTS_CONTROL_*` 冒充运行时。
- K5 启动完整性（`src/integrity/`、`src/cli/prts.ts`）：受保护包与源码树哈希进清单，
  清单文件的 sha256 由审计链最新 `integrity.manifest-updated` 锚定——清单只能经
  `node src/cli/prts.ts upgrade --install-root <d> --manifest <f> --db <f> --spec <f> [--init] [--yes]`
  修改（`--init` 仅首装、`--yes` 原子覆盖+写事件，否则 dry-run 退出码 2）。
  `Supervisor` 配 `integrity` 时校验失败不启动运行时。
- 预算：`blocked_json` 记 `by`（owner/model/system）；model 只能 unblock 自己造成的阻塞，
  且 `resume`/`unblock` 时 usage 已超 budget 抛 `BUDGET_EXCEEDED`（判定走 `fold.ts` 的 `usageExceeded`）。
