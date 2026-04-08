# 项目执行清单

目标：把 `claw-code` 主运行时和 `vscode-claw-sidebar` 一起推进到可交付、可验证、可发布的完成状态，而不是继续停留在“主体功能已在、收尾长期悬空”的状态。

## 当前状态快照

- Rust 主体功能已经基本成型；`ROADMAP.md` 里绝大多数阶段项已标记完成。
- 真正还卡在完成态前的，是少数收尾缺口：JSON 一致性、失败分类、MCP 端到端生命周期、session compaction、token/cost 精度、CI 稳定性。
- `vscode-claw-sidebar` 已经能用，但距离 `FINAL_SHAPE.md` 定义的 v1 还差一段，尤其是可靠性、状态透明度、上下文控制、会话体验和工程拆分。
- `vscode-claw-sidebar/extension.js` 当前约 `123 KB`，已经明显超过单文件可维护阈值，工程化拆分不能再往后拖。
- 当前工作树里的未提交 Rust 改动，明显是在做两类收尾：
  - 上下文窗口预检提前失败
  - Windows/Unix 差异导致的测试与路径兼容修复

## 完成态定义

以下全部满足，才算“完成态”：

- [ ] `cargo fmt --all --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] `PARITY.md` 的 `Still open` 只剩明确接受的非 v1 非阻塞项，或全部清零
- [ ] `ROADMAP.md` 里当前仍未完成的 P0/P1/P2 实质缺口全部关闭
- [ ] `vscode-claw-sidebar` 达到 `FINAL_SHAPE.md` 的 feature-complete v1 标准
- [ ] `vscode-claw-sidebar` 可稳定打包出 VSIX，版本号与产物一致
- [ ] README / USAGE / Sidebar README 与真实行为一致

## 执行顺序

严格按这个顺序推进，避免“功能越补越多，但主线一直不 green”：

1. 先收口当前未提交 Rust 改动，恢复工作区可验证状态。
2. 再清空 Rust 侧完成态阻塞项。
3. 然后完成 Sidebar 的 P0 稳定性与 P1 交互清晰度。
4. 再做 Sidebar 的 P2 核心生产力能力。
5. 最后做工程拆分、测试、打包、文档和发版。

## Phase 0: 收口当前本地改动

目标：先把现在已经在做的收尾改动整理成可合并状态，不要一边挂着脏改动，一边新增任务。

- [ ] 审核并完成 `rust/crates/api/src/providers/anthropic.rs`
  完成标准：上下文窗口超限在发请求前就能返回结构化错误，不再依赖 token-count API 成功后才失败。

- [ ] 审核并完成 `rust/crates/api/src/providers/mod.rs`
  完成标准：输入 token 估算逻辑对 provider 侧预检可复用，接口可见性不多不少。

- [ ] 审核并完成 `rust/crates/tools/src/lib.rs`
  完成标准：测试中的路径断言不再依赖 Unix 风格分隔符，Windows 上也稳定。

- [ ] 审核并完成 `rust/crates/plugins/src/hooks.rs`
  完成标准：Unix-only hook 测试在 Windows 上不会误编译、误运行或制造假红。

- [ ] 审核并完成 `rust/crates/plugins/src/lib.rs`
  完成标准：plugin lifecycle/tool 测试按平台条件正确收口，不再污染并行 CI。

- [ ] 审核并完成 `rust/crates/runtime/src/file_ops.rs`
  完成标准：symlink 相关测试在非 Unix 平台不再制造无意义失败。

- [ ] 审核并完成 `rust/crates/rusty-claude-cli/src/main.rs`
  完成标准：平台差异测试、MCP fixture 配置写入、布尔环境变量判断都收敛为稳定实现。

- [ ] 审核并完成 `rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs`
  完成标准：mock parity harness 的 Unix 权限行为只在 Unix 下运行，Windows 不再被无意义阻塞。

- [ ] 跑一轮 Rust 定向验证
  建议顺序：
  - `cargo test -p api`
  - `cargo test -p tools`
  - `cargo test -p plugins`
  - `cargo test -p runtime`
  - `cargo test -p rusty-claude-cli`

- [ ] 如果上述改动通过，单独整理为“平台兼容 + 预检前移”收口提交
  完成标准：这一批改动自身语义清晰，不和后续功能任务混成一个大杂烩。

## Phase 1: Rust 主运行时完成态阻塞项

目标：清掉 `ROADMAP.md` / `PARITY.md` 里真正还会阻塞“已完成”的核心缺口。

### P0. JSON / 状态契约一致性

- [ ] 修复 resumed `/status` JSON 输出不稳定问题
  来源：`ROADMAP.md` 条目 21
  文件重点：
  - `rust/crates/rusty-claude-cli/src/main.rs`
  - `rust/crates/rusty-claude-cli/tests/resume_slash_commands.rs`
  - `rust/crates/rusty-claude-cli/tests/output_format_contract.rs`
  完成标准：fresh 和 resumed 两条路径共用同一输出契约；显式请求 JSON 时永不回落到 prose。

- [ ] 审计所有 resumed slash command 的 JSON/text render 分流
  完成标准：`/status`、`/sandbox`、`/mcp`、`/skills`、`/init`、`/version` 都走统一渲染边界。

### P0. 失败分类与可恢复性

- [ ] 落地“用户可见但安全”的失败分类
  来源：`ROADMAP.md` 条目 22
  推荐错误类：
  - `provider_auth`
  - `session_load`
  - `command_dispatch`
  - `render`
  - `runtime_panic`
  - `transport`
  完成标准：用户界面不再只看到泛化报错，日志可通过 trace/session id 快速定位。

- [ ] 给主要失败出口补测试
  完成标准：至少覆盖 session 载入失败、provider 鉴权失败、命令分发失败、渲染失败。

### P0. CI 稳定性

- [ ] 修复 plugin lifecycle 并行测试易抖问题
  来源：`ROADMAP.md` 条目 24
  文件重点：
  - `rust/crates/plugins/src/lib.rs`
  - `rust/crates/rusty-claude-cli/src/main.rs`
  完成标准：`cargo test --workspace` 并行运行下稳定，无需 isolate 单测才能绿。

- [ ] 把当前平台条件编译改动跑通在至少一套 Windows 验证环境
  完成标准：Windows 不是“编译过了算成功”，而是相关测试真正稳定。

### P1. PARITY 剩余开放项

- [ ] 补完 MCP end-to-end lifecycle
  重点覆盖：
  - config load
  - server registration
  - spawn/connect
  - initialize handshake
  - tool/resource discovery
  - invocation path
  - error surfacing
  - shutdown/cleanup
  文件重点：
  - `rust/crates/runtime/src/mcp.rs`
  - `rust/crates/runtime/src/mcp_client.rs`
  - `rust/crates/runtime/src/mcp_stdio.rs`
  - `rust/crates/runtime/src/mcp_tool_bridge.rs`
  完成标准：`PARITY.md` 里的 MCP open item 可以关闭，不再只是 registry-backed approximation。

- [ ] 完成 session compaction 行为对齐
  完成标准：长 session 压缩行为有明确规则、回归测试和文档，不再作为 open item 悬空。

- [ ] 完成 token counting / cost tracking 精度收尾
  文件重点：
  - `rust/crates/api/src/providers/*`
  - `rust/crates/runtime/src/usage.rs`
  - `rust/crates/telemetry/src/lib.rs`
  完成标准：输入估算、输出统计、usage 汇总、用户可见成本信息彼此一致。

### P1. 仓库文档同步

- [ ] 更新 `PARITY.md`
  完成标准：把已完成、仍开放、接受延后项如实更新，不能保留过期描述。

- [ ] 更新 `ROADMAP.md`
  完成标准：把已关闭的阻塞项标成 done，把剩余真问题压缩到可信列表。

## Phase 2: Sidebar v1 稳定性

目标：先把 `vscode-claw-sidebar` 从“能用”推进到“稳定可靠、可判断失败原因”。

### P0. 环境与运行可靠性

- [ ] 统一 workspace root 检测
  文件：`vscode-claw-sidebar/extension.js`
  完成标准：无论用户打开 `A:\VCP` 还是 `A:\VCP\claw-code`，都能正确定位真实根目录和 `rust/run-with-cc-switch.ps1`。

- [ ] 重写 Quick Start 为结构化诊断
  诊断项至少包含：
  - workspace root
  - runner script
  - `claw.exe`
  - cc-switch 配置/数据库
  - Node
  - API env
  完成标准：UI 有明确 green/yellow/red，而不是单条模糊失败消息。

- [ ] 增加请求生命周期日志
  最少埋点：
  - ask sent
  - process started
  - first chunk
  - last chunk
  - stderr received
  - exit code
  - cancelled
  完成标准：用户或开发者能判断“没回消息”到底卡在哪一段。

- [ ] 缺失依赖时报错要可操作
  覆盖：
  - PowerShell
  - Node
  - `better-sqlite3`
  - `claw.exe`
  - `run-with-cc-switch.ps1`
  - API key / base URL
  完成标准：每种失败都能给出明确修复建议。

### P1. 状态清晰度

- [ ] 加入显式 run status indicator
  状态至少包含：
  - `Idle`
  - `Starting`
  - `Checking environment`
  - `Waiting for model`
  - `Streaming`
  - `Done`
  - `Cancelled`
  - `Failed`
  完成标准：每次请求在 UI 中都有唯一、可见的状态。

- [ ] 明确区分 system output 和 assistant reply
  完成标准：doctor/status/startup/error 信息不再伪装成聊天回复。

- [ ] 清理顶部 action 布局
  完成标准：保留核心操作直达，同时减少按钮噪音，把次要能力放回命令面板。

- [ ] 改善 session list 交互
  至少补齐：
  - rename
  - recent activity
  - recent-first sort
  完成标准：会话体验更接近真实 chat client。

## Phase 3: Sidebar v1 核心生产力

目标：补齐真正影响日常使用的 v1 能力。

- [ ] 增加 richer context attachment
  至少支持：
  - 无额外上下文
  - active editor
  - selected code
  - current file
  - 手动文件路径附加
  完成标准：发送前 UI 始终能看清当前附带了什么上下文。

- [ ] 增加 regenerate
  完成标准：一键重跑上一轮用户输入，不依赖手工复制粘贴。

- [ ] 增加 full-message copy
  完成标准：整条 assistant 回复可复制，而不只限代码块 copy。

- [ ] 增加 insert-to-editor
  完成标准：能把选中的返回代码插回当前编辑器，而不是只复制到剪贴板。

- [ ] 增加 CLI session resume 支持
  涉及文件：
  - `vscode-claw-sidebar/extension.js`
  - `rust/crates/rusty-claude-cli/src/main.rs`
  完成标准：Sidebar 不只是恢复本地 UI，会话还能接回真实 `claw --resume` 上下文。

## Phase 4: Sidebar 工程化与可维护性

目标：把单文件扩展整理成可长期维护、可测试、可发布的结构。

- [ ] 拆分 `vscode-claw-sidebar/extension.js`
  目标文件结构：
  - `extension.js`
  - `src/provider.js`
  - `src/webview.js`
  - `src/runner.js`
  - `src/workspace.js`
  - `src/sessions.js`
  - `src/diagnostics.js`
  完成标准：主入口只负责 activate 和装配，不再堆业务逻辑。

- [ ] 给最脆弱路径补自动化测试
  第一批必测：
  - workspace root detection
  - prompt composition
  - session persistence
  - stdout fallback behavior
  完成标准：不是只有手点验证，核心逻辑能重复回归。

- [ ] 固化版本与打包流程
  完成标准：
  - `package.json` 版本号规则明确
  - `vsce package` 产物名与版本一致
  - 发版前检查步骤固定

- [ ] 清理 README 与最终行为不一致的描述
  完成标准：开发说明、依赖说明、运行方式、限制条件都和现状一致。

## Phase 5: 最终验收与发布

目标：不是“代码看起来差不多”，而是真正完成一次可以交付的闭环。

- [ ] 按 `vscode-claw-sidebar/FINAL_SHAPE.md` 的 Acceptance Test Script 跑完整体验
  至少验证：
  1. 打开 `A:\VCP`
  2. Sidebar 正确解析 `claw-code`
  3. Quick Start 绿/黄/红报告正常
  4. 发送简单 prompt 成功
  5. Ask Selection 正常注入上下文
  6. 代码块 copy 正常
  7. Regenerate 正常
  8. Reload 后会话仍在

- [ ] 跑最终 Rust 全量验证
  - `cargo fmt --all --check`
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo test --workspace`

- [ ] 打包 VSIX
  完成标准：产物可安装，版本号正确，README 不失真。

- [ ] 发布前文档同步
  需要同步：
  - `README.md`
  - `USAGE.md`
  - `PARITY.md`
  - `ROADMAP.md`
  - `vscode-claw-sidebar/README.md`

- [ ] 形成 release closeout
  至少包含：
  - 本次关闭了哪些阻塞项
  - 还有哪些明确延后项
  - 下一版本只保留哪些非阻塞增强项

## 建议的实际推进批次

为避免任务过大，建议按 5 个批次执行：

### 批次 A

- 收口当前 Rust 脏改动
- 恢复 `cargo test --workspace` 基线

### 批次 B

- 修 resumed JSON 契约
- 修失败分类
- 修 plugin lifecycle test flake

### 批次 C

- 完成 MCP e2e lifecycle
- 完成 session compaction
- 完成 token/cost accuracy

### 批次 D

- 完成 Sidebar P0/P1
- 跑一轮人工验收

### 批次 E

- 完成 Sidebar P2/P3
- 拆分模块、补测试、打包 VSIX
- 文档同步并出 release closeout

## 明确不再继续拖延的事项

以下事项不应再被视为“以后再说”：

- [ ] `extension.js` 单文件继续膨胀
- [ ] resumed JSON 输出继续保留双路径行为
- [ ] MCP 只停留在 registry bridge，不补 end-to-end
- [ ] CI 绿但 workspace 并行测试不稳定
- [ ] README / ROADMAP / PARITY 与真实状态脱节
