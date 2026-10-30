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
- 数据规则：`ledger_events` 是唯一事实来源（只追加、sha256 链）；`tasks`/`task_steps`/`evidence`
  只能由 `fold.ts` 的 `applyEvent` 更新；每个变更在一个 SQLite 事务内「追加事件 + 应用投影」。
- 预算：`blocked_json` 记 `by`（owner/model/system）；model 只能 unblock 自己造成的阻塞，
  且 `resume`/`unblock` 时 usage 已超 budget 抛 `BUDGET_EXCEEDED`（判定走 `fold.ts` 的 `usageExceeded`）。
