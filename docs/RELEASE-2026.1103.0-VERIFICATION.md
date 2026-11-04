# 2026.1103.0 发版验收

状态：2026-11-04 用户要求暂停，剩余验收未执行，尚未公开发布或 push 本轮改动。安装版已恢复并核对最终版本与哈希，无残留应用/网关/基准进程；恢复后按 [暂停交接](HANDOFF-2026.1103.0-PAUSED.md) 继续。

包含前一轮启动/工作空间/Dock/QQ 优化及本轮人工审查修复。内核保持 OpenClaw 2026.10.9、Node 24.22.1，兼容下限 2026.7.0。

最终四层回归已通过，Windows x64 安装包构建完成。安装、性能、UI、真实消息、公开资产和远端 push 的证据逐项补录，未完成条目不计为通过。

## 已完成的最终来源门禁

- `.cache/release-1103-final-tests.log`：vitest/chat/node/scripts 四层全部通过，27660ms；另有内核更新、回退和兼容定向回归 64 项通过。
- `.cache/release-1103-build.log`：最终 Windows x64 构建完成，TypeBox 共享布局复用 17 个文件。保持 Electron 43.8.3、独立 Node 24.22.1 与物理 OpenClaw 2026.10.9。
- `.cache/release-1103-install.log`：安装同批 `CryoClaw-Setup-2026.1103.0-x64.exe`，安装位 app.asar 版本与实际原生运行时/内核资源核对通过。安装前无活动应用、网关或附着验收实例。
- 安装位 `resources/install-performance.json`：`payloadMode=rename`、`fallback=none`、`win32Error=0`、`installMs=160875`。这是本次安装观测，不据此宣称相对安装提速。
- `.cache/check-kernel-release-pin.cjs`：官方仓库 pin、安装内核、最低 Node 与安装更新器 fallback 一致，旧 Node 被拒绝，兼容下限仍为 2026.7.0。

## 本版三轮启动观测

`out/backend-performance/release-1103/report.json`：三轮均完成真实固定 RPC、零 renderer 异常和正常退出；同一配置、状态目录、机器、运行时及未清理现有缓存声明。界面可用中位 130.37 秒、网关 ready 中位 110.38 秒、完整工作流中位 140.67 秒；稳态 RPC p95 6ms。

本轮显著慢于较早候选，不能以旧候选 84.54 秒代替本版 130.37 秒。严格身份检查允许进行数值对照，但不包含 CPU 频率、后台扫描等运行时环境控制；原因尚未确认，正在补当前时段受控基线。此前受控优化结果保留为历史记录，不作为本版提速保证。
