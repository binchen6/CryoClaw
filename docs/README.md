# CryoClaw 文档索引

docs/ 目录导航。改代码前建议先读 gotchas.md 与 OPTIMIZATION-PROGRESS.md 的「关键路径地图」。

| 文档 | 用途 |
|---|---|
| `OPTIMIZATION-PROGRESS.md` | 优化工程进度追踪（断点续作锚点）：当前状态、关键路径地图、各轮 R 记录、测试基线 |
| `architecture.md` | 架构分层说明：三进程模型、主进程模块职责、启动链路 |
| `ipc-api.md` | 主进程 IPC 通道契约清单（preload 暴露的全部方法与事件） |
| `design-guidelines-zh.md` / `design-guidelines-en.md` | UI 设计规范（中英双语）：design token、组件原语、布局规则 |
| `gotchas.md` | 已验证坑清单（104 条，改代码前先搜一遍） |
| `releasing.md` | 发布流程：版本 bump、打包、静默安装验证、gh release |
| `client-ticker.md` | Chat UI 30 秒公共定时器机制与已注册 handler |
| `kernel-recon/` | 内核升级侦察记录（2026.9.2 / 2026.9.3 diff 等，升级内核前先读） |
| `archive/` | 历史档案：已完成/过时的实施计划（plans/）、已被取代的设计（specs/）、已完成的 2026.9 UI 重写契约（`ui-rewrite-2026.9-contract.md`，v2026.903.0 落地）、已闭环的安全整改记录（`security-remediation-plan.md`）、被 kernel-recon 取代的 2026.8.2 调研、一次性 prompt 等 |
