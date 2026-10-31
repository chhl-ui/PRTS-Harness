# prts-system

PRTS 受保护核心：任务账本、授权、停止、审计、启动完整性，以及把这些接进 DSH 运行时的入口。
纯 TypeScript，`node:sqlite` 持久化，只追加哈希链事件 + 可重建投影。

**这是 PRTS 当前唯一在办的主线。** 其它 PRTS 目录的地位见 `C:\Users\Administrator\Desktop\PRTS-INDEX.md`。

## 跑起来

```sh
npm install       # 依赖：@deepseek-ai/dsh-* 0.2.1-rc.2（RC 版本，升级需复验接口）
npm test          # node --test，62 例，约 32 秒
npm run typecheck # tsc -p .（strict + noEmit + erasableSyntaxOnly）
```

## 目录

```
src/
  chain/        共享链原语（canonicalJson / sha256hex / chainHash / verifyChainRows）
  ledger/       K1 任务账本：append-only 事件 + fold.ts 投影
  audit/        K4 审计：同一 DB、独立表、独立链
  authority/    K2a 授权：Authority.guard 是唯一强制点（同步、返回理由串即拒绝）
  stop/         K3 分级停止 StopController
  supervisor/   K3 进程外守护：Job Object、控制管道认证、崩溃重启限额
  integrity/    K5 启动完整性：受保护包与源码树哈希，锚在审计链
  cli/          prts upgrade（清单只能经它修改）
  runtime/      K6 运行时入口 main.ts + start.ts（boot 组合 + 内存 credentials）
config/prts.yml 组合树（sdk-minimal 展开，自 sdk-app/jsonrpc 与账户链中剥离）
test/           62 例；test/support/ 是驱动、脚本化模型替身、临时目录
.scratch/       一次性诊断探针（gitignore，不参与测试）
```

## 必须守住的不变量（细节见 AGENTS.md）

- 守卫是唯一强制点。`pre-execute` 瀑布与审批应答都可能被前置插件伪造，守卫在后面仍会拒。
- 真实运行时必须在派生任何子进程之前调用 `connectControl`，并把控制 env 读即删。
- 所有者命名管道只接受 `stop` 和 `status`；控制管道 token 每次重启换新、`timingSafeEqual` 比对、pid 必须等于 Job 内运行时 pid。
- key 只存在于内存 credentials 服务，不进环境变量，不落模型可读的位置。
- 账本/审计是事实来源；投影只能由 `fold.ts` 的 `applyEvent` 更新。
- `startupCheck` 返回 read-only 时不得调用 `initCoreDb`，只能只读打开。

## 当前状态

- HEAD `b3cb34b`（2026-10-30 19:18）"Runtime integration 2a"：真实 DSH 组合在自有守护进程下跑通，模型由脚本替身驱动。
- 未接真实模型：见下条 O1。
- 未提交的遗留：`test/runtime/enum-tools.ts`（10-30 21:18，Devin 留下的孤儿文件，不参与测试）。

## 已知缺陷

- **O1（阻塞真实对话）**：agent 轮次发给适配器的 `options.messages` 含 `undefined` 元素，序列化时崩在 `dsh-llm-deepseek/lib/index.js:1688`，被 `generate()` 兜底 catch 包成 `TRANSPORT`。表现是请求零发出、终端无任何错误。复现脚本在 `.scratch/o1-probe.test.ts`。
- dispose 后进程不退出（探针需 `--test-force-exit` 才收住），句柄未释放，原因未查。

## 文档

- 设计与计划：`C:\Users\Administrator\Desktop\设计和计划\`（先读其中的 README.md）
- 最新设计：`PRTS-DESIGN-02-RUNTIME-INTEGRATION-2026-10-30.md`（§8A/§8B 是 2a 步的实测记录）
