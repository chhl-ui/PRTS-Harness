# Agent harness 的沙箱与权限隔离：横向对比（2026-11-01）

## 这份文档回答什么

PRTS 的 shell 沙箱走过一段弯路：local 后端在标准 workspace 上起不来、appcontainer 里 node/git 读不到。这两件事的根因都不在 PRTS 的代码里，而在「**一个 agent harness 在 Windows 上到底该怎么给模型 shell**」这个更大的问题上。

本文横向看六家怎么做，回答两件事：别人的取舍是什么，PRTS 现在的取舍偏不偏。

## 方法与证据纪律

每条判定带 `file:line`。证据分两级：

- **[实测]**——写作本文时直接读代码/grep 确认。只复核了支撑主要结论的两条（见 §3、§4），不是为了省钱，是因为其余结论的用途是「参考」，不是「依据」。
- **[探查]**——来自只读代码探查，未逐条复核。引用前按 `docs/external-reference-research.md` 的纪律自行核实。

源码位置：`C:\Users\Administrator\Desktop\参考库\agent-code\20261019\repos\{codex,nanoclaw,pi,goose}`、`...\20261029\repos\deepseek-harness`。

## 一、横向表

| harness | 隔离层 | Windows 上怎么做 | 默认状态 |
|---|---|---|---|
| **Codex** | Seatbelt / bwrap+seccomp / RestrictedToken+WFP | 完整 OS 级：受限令牌 + 能力 SID + 改 DACL + WFP 网络过滤 + 两个独立本地账户 + 私有桌面 + 提权 provisioning 服务 | **`Disabled`** |
| **NanoClaw** | Docker 容器 | 无本机方案，靠 WSL2 | 容器是默认 |
| **pi** | 无 | 无 | 直接 spawn |
| **goose** | 无 | 无 | 审批策略 |
| **DSH**（PRTS 的底座） | bwrap / Landlock / Seatbelt / Windows ACL | **只限写**，读/网络/进程可见性都不管 | 按 policy |
| **PRTS** | AppContainer（读）+ DSH ACL（写） | 自建读隔离 | `local`（已坏） |

## 二、Codex：最重的一套，但默认关着

**三后端**，枚举在 `protocol/src/sandbox.rs:29` 的 `SandboxType`（`None` / `MacosSeatbelt` / `LinuxSeccomp` / `WindowsRestrictedToken` / `WindowsMxc`），平台选择在 `sandboxing/src/manager.rs:48-60`。

- **macOS**：Seatbelt，SBPL 策略文本 `include_str!` 载入（`sandboxing/src/seatbelt.rs:21-27`）
- **Linux**：bubblewrap 为主 + seccomp，landlock 降级为 legacy；执行体是独立 helper 二进制，argv0 复用自身（`sandboxing/src/landlock.rs:7,22-40`）
- **Windows**：完整 OS 级，不是「只读近似」——
  - `CreateRestrictedToken(base_token, DISABLE_MAX_PRIVILEGE|LUA_TOKEN|WRITE_RESTRICTED, ...)`（`windows-sandbox-rs/src/token.rs:480-513`）
  - WFP 持久化过滤器只放行回环代理端口（`wfp.rs:41-48,67-77`）
  - 两个真实本地账户 `CodexSandboxOffline` / `CodexSandboxOnline`（`setup.rs:52-54`）
  - 私有桌面（`wrapper.rs:15`）

**但默认是关的。** `protocol/src/config_types.rs:297-302` 实测：

```rust
pub enum WindowsSandboxLevel {
    #[default]
    Disabled,
    RestrictedToken,
    Elevated,
}
```

一关就退回「审批 + execpolicy 命令前缀决策」，没有任何 OS 级强制。

**分级代价**：unelevated 的受限令牌只能限写，凡需要 deny-read / 读分裂策略的请求直接 `refusing to run unsandboxed` 报错（`sandboxing/src/windows.rs:101,117,128,151,181`），不降级执行。

**降级只有两条路，都要用户点头**：`SandboxOverride::BypassSandboxFirstAttempt` 与 `EscalatedSandboxWithRestrictions`（`protocol/src/sandbox.rs`）。

**workspace-write 不等于整个 workspace 可写**：`WritableRoot` 带 `read_only_subpaths`，`.git` / `.agents` / `.codex` / `.aws` 保持只读，另有 `forbidden_agent_metadata_write` 前置拦截（`protocol/src/permissions.rs:46`）。

## 三、DSH：PRTS 的底座，只做写限制

`packages/sandbox` 下四个包：`sandbox`（seam/契约）、`sandbox-local`（多平台后端）、`sandbox-policy`（部署默认与 per-session 覆盖）、`sandbox-windows-acl`（win32 写限制）。

**Windows 后端的边界是明确的**——`sandbox-windows-acl/src/index.ts:27-28` 实测：

> writes are restricted; reads, network, and process visibility are NOT
> (WRITE_RESTRICTED intersects only write accesses)

机制：复制调用者令牌 + `WRITE_RESTRICTED`，restricting SID 带 workspace/temp 两个能力 SID，Windows 做两次访问检查（普通 SID + restricting SID，两者都过才给写）；再把令牌降到 Low integrity；每个被授予目录在一次 `SetNamedSecurityInfoW` 里同时加 capability allow ACE、对 world 拒绝 `FILE_DELETE_CHILD`、打 Low label。

这解释了 PRTS 为什么要另做 AppContainer 读隔离——**DSH 的 Windows 后端根本不管读**。

DSH 的不可用处理是 fail-closed：`SandboxUnavailableError` / `SANDBOX_UNAVAILABLE`，「refusing to run the command unconfined」。

## 四、三家轻量的

**NanoClaw**：Docker 容器级隔离，反过来用**白名单**而不是黑名单——宿主侧按 allowlist 组装挂载清单（`src/modules/mount-security/index.ts:312`），只读用 `:ro` 表达（`src/drivers/docker-driver.ts:809-813`），容器加 `--cap-drop=ALL` / `no-new-privileges`（`:780-783`）。模型侧无逐次审批。Windows 靠 WSL2，本身无本机沙箱。

**pi**：核心 bash 工具直接 `spawn`（`packages/coding-agent/src/core/tools/bash.ts:112`），**无沙箱无审批**。沙箱只存在于 `examples/extensions/sandbox`，且 `if (platform !== "darwin" && platform !== "linux") sandboxEnabled = false`（`:251-253`）——Windows 上自动关闭。

**goose**：无进程级沙箱（`crates/goose/src/lib.rs:9-60` 的模块表里没有 sandbox），靠工具调用前的 inspector：`GooseMode`（Chat/Auto/Approve/SmartApprove）× `PermissionLevel`（AlwaysAllow/AskBefore/NeverAllow），无匹配时默认 needs approval（`permission/permission_inspector.rs:150-189,100-110`）。

## 五、对 PRTS 的四条启示与落地状态

| 启示 | 依据 | PRTS 落地 |
|---|---|---|
| Windows 上默认不开沙箱是业界常态 | Codex 这么重的实现也 `Disabled` | 已采纳：保留 `local` 默认 + `localBackendWarning` 启动警告（`4fcd5b7`） |
| workspace 内的只读子路径 | Codex 的 `WritableRoot.read_only_subpaths` | 已做：`readOnlySubpaths`，缺省 `['.git']`（`6737377`） |
| 不可 enforce 时提前判断而非每条命令撞 | Codex/DSH 都是 fail-closed | 部分：`localBackendWarning` 已提前判断，但只是警告，不是拒绝执行 |
| 接 DSH 的 escalation | — | **撤销**：见下 |

**为什么撤销「接 escalation」。** `src/cli/chat.ts:5-13` 的注释写清了根因：DSH 的 fs escalation 要求「组合里有 confining fs backend」，而 PRTS 用的是 `@deepseek-ai/dsh-fs-local`，那条通道走不通。但 PRTS **有自己的等价机制且更顺**——E3 审批挂在 `tools/pre-execute`，`authority.decide` 返回 `ask` 时自动弹终端问人（`src/runtime/start.ts:200-225`）。

| | DSH escalation | PRTS E3 |
|---|---|---|
| 触发 | 模型带 `sandbox_permissions` 参数重试 | 守卫判 `ask` 时自动问 |
| 模型需要知道协议吗 | 要，还得给 justification | 不用 |
| 人看到什么 | 一条重试请求 | 当场的审批提示 |

「PRTS 缺 escalation」是调研不到位的结论，不是事实。

## 六、PRTS 现在站在哪

**结构上**：PRTS 和 NanoClaw 走同一条思路——**白名单而非黑名单**。NanoClaw 只挂载 allowlist 里的目录，PRTS 的 AppContainer 只授权 workspace + `--read-path` 列表。这条路比 Codex 的「改造令牌 + DACL + WFP」轻得多，代价是覆盖面窄：AppContainer 管不到网络，Codex 用 WFP 管。

**代价上**：Codex 那套（提权 service + 两个本地账户 + 私有桌面）是为企业部署准备的。PRTS 是单用户、单机、非敌对环境，不需要。

**方向上**：没有走偏。缺的是两块低成本项——只读子路径（已补）、以及「不可 enforce 时拒绝执行而非仅警告」（未做，见 §5 第三行）。

## 附：未核实项

- 本文的 [实测] 只覆盖两条：Codex `WindowsSandboxLevel` 默认值、DSH windows-acl 的写限制边界。其余均来自只读探查。
- goose 是否在别处（其他 crate 或 docs）提供沙箱能力，未枚举全部 crate。
- pi 是否存在未读到的审批/白名单层，只确认了核心 bash 工具本身无审批点。
- Codex 的 Windows 后端未在真机上启用复现，行为依据源码与测试断言。
- Codex 部分行号为 grep 上下文推断，符号级准确，行号可能有 ±5 偏差。
