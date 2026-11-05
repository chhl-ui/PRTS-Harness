# K2b：exec / tool / system 的边界设计（2026-11-05）

**为什么单独立一条**：README「已知限制」与交接 §4.1 都写着「守卫只过滤 `fs.*` + `net.*`，
exec/tool/system 归 K2b」。这是唯一一条**安全边界**性质的未完成项，不能靠调参或加测试解决。

## 一、现状（读码核实，不是转述）

| 层 | 事实 | 位置 |
|---|---|---|
| 分类 | `classify` **已经**把 `pwsh` 判成 `exec`、未知工具判成 `tool(<name>)` | `src/authority/classify.ts:45-71` |
| 判定 | `evalCap` **已经**有语义：`system` → ask；`exec`/`tool` → 有 grant 则 allow，否则 **ask** | `src/authority/authority.ts:293-308` |
| 挂载 | `guard` 挂载时**显式过滤**掉 exec/tool/system，只保留 fs/net | `src/runtime/start.ts:407-409` |
| 沙箱 | AppContainer 后端、workspace ACL、runner 均已在位；`sandboxBackend` 开关存在，**默认 `local`** | `src/sandbox/*`、`src/runtime/start.ts:135` |

过滤的理由写在 `start.ts:396-406` 的注释里，且成立：**K2a 对 pwsh 只能整体放行或整体拒绝**
（命令体内的写/删识别不了），整体拒绝会让 `test/runtime/runtime.test.ts` 的 R2 必红，
而"整体拒绝"也不是真正的边界——命令可以换任何写法绕过静态识别。

## 二、三条候选路线

| 路线 | 做法 | 代价 | 判定 |
|---|---|---|---|
| **A. 命令解析** | 在 `classify` 里解析 pwsh 命令体，识别 `Remove-Item` / `Set-Content` / `>` 重定向 → 映射 fs 能力 | 脚本语言不可静态分析：变量拼接、`& $cmd`、base64、外部脚本都能绕过；漏判一次等于没有边界 | **否决**——它给的是"看起来有边界" |
| **B. OS 层沙箱**（K2b 本义） | `sandboxBackend='appcontainer'` 时，pwsh 进程被 ACL 限制只能写工作区；执行器层不再需要逐条判定命令 | 已有组件；需真机验证 ACL 在 pwsh 路径上真的生效 | **推荐** |
| **C. exec 默认 ask + 会话级 grant** | 打开 exec 判定，pwsh 每次弹审批或提前 grant | 交互成本高（pwsh 是高频工具）；且不能防"批准过一次就长期放行"的漂移 | 只作过渡，不作终局 |

## 三、推荐方案（B，带一条明确边界）

1. `sandboxBackend === 'appcontainer'` 时：exec 能力的边界由 OS ACL 保证，
   `guard` 继续不判 exec（不是遗漏，是分工），但**必须有一条真机测试**证明
   AppContainer 下的 pwsh 写入工作区外被拒。
2. `sandboxBackend === 'local'`（当前默认）时：exec 没有边界，README 必须写明
   **不是"未实现"而是"未启用"**，并指出切换到 appcontainer 是唯一开关。
3. `tool(...)`（未知 MCP 工具）：维持现状不判——它们的副作用无法分类，
   判定只能靠沙箱或人工 grant，不在本轮范围。

## 四、验收判据（可自动化）

- 真机（AppContainer）：`pwsh` 写工作区内文件 → 成功；写工作区外/受保护目录 → 失败且
  进程返回非零；两条都在同一测试文件里，避免"只验了一半"。
- 回归：`sandboxBackend='local'` 下 R2 仍绿（既有 pwsh 用例不受影响）。
- 文档：README 的「已知限制」改为"exec 边界由沙箱后端决定，默认 local 无边界"。

## 五、本轮不实施的理由

`src/sandbox/` 虽已具备组件，但「AppContainer 下 pwsh 的真实写入边界」需要真机验证
（`scripts/grant-sandbox-read.ps1` 等既有工具体现过这类验证的门槛）。这是安全边界，
不能靠单元测试替身证明。按项目的 fail-closed 纪律：没有实测证据前，不改守卫、
不把它写成"已修"。**下一步若要推进 K2b，从 §四 的第一条测试开始。**
