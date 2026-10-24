# CryoClaw 文档索引

先读 [当前交接](OPTIMIZATION-PROGRESS.md) 与 [已验证问题](gotchas.md)，再按范围进入专项文档。当前状态与历史档案分开维护，旧测试数量不代表现行基线。

| 文档 | 用途 |
|---|---|
| [OPTIMIZATION-PROGRESS.md](OPTIMIZATION-PROGRESS.md) | 当前版本、五轮范围、开发命令与关键路径；历史记录另行归档 |
| [REVIEW-2026.1022.0.md](REVIEW-2026.1022.0.md) | 10.5 内核、网关启动、独立仪表盘、交付插件与缓存方案的审查及实测 |
| [REVIEW-2026.1023.1.md](REVIEW-2026.1023.1.md) | 看板示例、共享模型菜单、自然动效、性能及安全审查 |
| [REVIEW-2026.1023.0.md](REVIEW-2026.1023.0.md) | 10.6、独立 Node、过期补丁清理及物理内核更新/回退审查 |
| [CONTEXT-CACHE-OPTIMIZATION-PLAN.md](CONTEXT-CACHE-OPTIMIZATION-PLAN.md) | 已确认的上下文与模型缓存优化范围、边界和验收方法 |
| `architecture.md` | 架构分层说明：三进程模型、主进程模块职责、启动链路 |
| `ipc-api.md` | 主进程 IPC 通道契约清单（preload 暴露的全部方法与事件） |
| `design-guidelines-zh.md` / `design-guidelines-en.md` | UI 设计规范（中英双语）：design token、组件原语、布局规则 |
| [gotchas.md](gotchas.md) | 已验证问题与约束；数量以文件中的编号为准 |
| `releasing.md` | 发布流程：版本 bump、打包、静默安装验证、gh release |
| [MAINTENANCE.md](MAINTENANCE.md) | 过期缓存与输出清理、保留规则和路径边界 |
| [RELEASE-2026.1019.0-VERIFICATION.md](RELEASE-2026.1019.0-VERIFICATION.md) | 本轮五轮优化、磁盘清理、安装与发布验收 |
| [RELEASE-2026.1018.3-VERIFICATION.md](RELEASE-2026.1018.3-VERIFICATION.md) | 上一版六轮修复及低完整性安装问题的取证 |
| `RELEASE-2026.1018.1-VERIFICATION.md` | 10.4 内核、模型保存、通知与交互补丁验证记录 |
| `RELEASE-2026.1018.0-VERIFICATION.md` | 上一版功能证据与发布验收 |
| `CODEX-SUBSCRIPTION-INTEGRATION.md` | ChatGPT/Codex 原生账户协议、独立代理、模型与额度联动及验收状态 |
| `MODEL-QUOTA.md` | 各供应商额度与余额来源、输入框圆条、刷新缓存、未知状态与验收边界 |
| `VISUAL-SYSTEM.md` | CryoBlue 蓝绿配色、控件/图标标准、深浅主题与弹层交互 |
| `THEME-STUDIO.md` | 字体与主题方案、可视化控件编辑、Agent 实时预览接口与验证 |
| `client-ticker.md` | Chat UI 30 秒公共定时器机制与已注册 handler |
| `kernel-recon/` | 内核升级侦察记录（2026.9.2 / 2026.9.3 diff 等，升级内核前先读） |
| `archive/` | 历史档案：已完成/过时的实施计划（plans/）、已被取代的设计（specs/）、已完成的 2026.9 UI 重写契约（`ui-rewrite-2026.9-contract.md`，v2026.903.0 落地）、已闭环的安全整改记录（`security-remediation-plan.md`）、被 kernel-recon 取代的 2026.8.2 调研、一次性 prompt 等 |
