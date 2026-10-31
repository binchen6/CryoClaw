# CryoClaw 2026.1031.0 发布验收

> 状态：本地验收完成，发布中。本文只记录当前实测，公开 Release 与资产断言结果在发布完成后补齐。

## 范围

本版覆盖模型供应商工作台与品牌图标、统一方向动效、插件跨进程缓存、消息发送/接收、启动与全页面性能、构建更新链和测试发布效率。没有调用收费 provider，没有使用 `--live`，没有读取或改写真实模型凭据。

## 插件加载实测

真实环境：Windows、74 个插件、8 个渠道。缓存绑定原始配置、状态目录、内核版本与 inventory 环境；损坏或指纹变化回退原 CLI，安装/卸载/更新/启停同步失效。

| 链路 | 首次读取 | 后续读取 | 数据一致性 |
|---|---:|---:|---|
| 启动 inventory | 1567.7ms | 2.5ms / 1.8ms | 74 插件、8 渠道三次一致 |
| 插件列表 | 3697.9ms | 进程内 2.1ms；模块重载 2.0ms | 74 插件逐项一致 |

这不是首次发现成本的消除，而是避免后续进程重复支付同一发现成本。缓存写入使用原子替换，不含 API key 或其他秘密。

## 启动与 RPC 对照

同一机器、配置、内核、Node 和固定工作负载，2026.1030.0 与 2026.1031.0 各三次启动；不清 OS/文件缓存。

| 指标 | 2026.1030.0 | 2026.1031.0 | 变化 |
|---|---:|---:|---:|
| 完整可用中位 | 71.57s | 56.73s | -20.7% |
| 网关就绪中位 | 61.12s | 48.91s | -20.0% |
| 综合前后端中位 | 75.36s | 60.83s | -19.3% |
| 首个 RPC 批次中位 | 0.92s | 0.75s | -18.9% |
| 稳态 RPC p95 | 113.4ms | 4.1ms | 实测下降，受本机波动影响 |
| 网关观测 CPU 中位 | 84.39s | 71.17s | -15.7% |
| 网关峰值工作集中位 | 1.63GB | 1.67GB | +2.6%，不作为改善 |

比较报告：`out/backend-performance/baseline-2026.1030.0-20261031/report.json` 与 `out/backend-performance/candidate-2026.1031.0-20261031/report.json`。`overallSpeedup=1.2389`，不是冷 OS 缓存保证或所有配置承诺。

## 消息发送与流式接收

隔离 Electron 使用构建后的真实 renderer，附件文件 IPC 与 gateway 事件均为合成；不连接真实账户或网络。

- 1/4/8 个附件均按原顺序发送并显示 echo，读取在途上限分别为 1/4/4；80ms 假读盘场景总耗时 181.0 / 100.3 / 175.9ms。8 文件是两批各 4 个，不冒充单批并行。
- 20k 文本底部接收：p95 6.4ms/帧，无 long task。
- 100k 文本底部接收：p95 10.5ms/帧，无 long task。
- 100k 文本向上阅读：p95 4.8ms/帧，无 long task；无文本丢失、无 renderer exception。
- 重复流气泡判重微基准（100,007 code units、2,000 次/轮、5 轮）中位 53.3044ms → 19.0474ms，仅是纯函数夹具，不是端到端时延。

报告：`out/chat-stream-performance/current-20261031/report.json`。

## 全页面性能

36 个页面均完成测量。外部插件市场仍因网络进入错误终态，不能将更快报错计为提速；`pagesSuccessful=false` 只针对该外部页面。

- 已安装插件：首访 5339.7ms → 4545.8ms，复访 74.0ms → 92.7ms；缓存命中场景与首轮冷读分开解释。
- 模型设置：首访 689.9ms → 514.3ms，复访 198.9ms → 195.5ms。
- 对话：首访 88.3ms → 73.7ms，复访 91.8ms → 71.1ms。
- 任务：首访 1378.5ms → 1322.8ms；渠道元数据改为任务页按需加载，复访增加一次 channels.status，属于有意调整。
- 外部技能商店与插件市场仍受网络主导；没有为速度伪造成功状态。

报告：`out/frontend-page-performance/baseline-2026.1030.0-20261031/report.json` 与 `out/frontend-page-performance/candidate-2026.1031.0-20261031/report.json`。

## UI、动效与可访问性

- 供应商目录、详情、添加三层工作台；预设图标参考 Simple Icons / Lobe Icons 公开矢量源，重新绘制为单色简化几何，16/24px 可辨识，无运行时图片请求。
- 顶层视图、设置、任务、工作区/扩展子 tabs 和供应商三层统一方向过渡；前进从右侧 8px 淡入，返回从左侧 8px 淡入，reduced-motion 直接终态。
- 工具读取、请求编辑 diff、命令/输出、复制、换行、8k 有界显示与完整原文入口保留；异步高亮不接管 Lit ChildPart。
- 停止按钮中性表面与 destructive 方块通过明暗/宽窄实测；快捷键只列真实绑定，命令记录不伪造后台进程状态。
- 供应商工作台 30 个场景通过，覆盖 1440/800/600 × 明暗、17 个预设图标、长 ID、底栏、搜索、秘密遮蔽和零 renderer exception。

安装版完整 UI 与发布资产验收结果将在下文补齐。

## 构建、测试与发布效率

- `npm run build`：通过。
- 四层测试默认并发由 2 层提高为 3 层，保留 `--serial` 和 `CRYOCLAW_TEST_CONCURRENCY` 降级；未减少测试项。
- 当前完整测试：**2677 passed / 6 skipped / 0 failed**，约 21 秒；此前同树约 31 秒。
- `npm run test:typecheck` 与 `git diff --check`：通过。
- `reference-ui-smoke`、`dashboard-perf-cdp-smoke`、`provider-workbench-cdp-smoke` 均通过；隔离 fixture 的 hidden/rAF 问题通过禁用后台节流修复，未放宽断言。

## 归档与当前文档

阶段交接与任务报告已移入 `docs/archive/`，相对链接同步修正；当前发布验证、架构、设计规范和发布指南留在 `docs/` 根部。图标来源与统一动效规范见 `documents/designs/provider-workbench.md`、`docs/design-guidelines-zh.md` 和 `docs/design-guidelines-en.md`。

## 最终安装与发布验收

- 最终 Windows 安装器：`CryoClaw-Setup-2026.1031.0-x64.exe`，316,621,847 字节；SHA-256 `40d1e1b34b56db14fbb12e4333e2289f411fc0a7ff227fbb85c39294f3724d5a`。对应 `.exe.blockmap` 与 `latest.yml` 同批生成，版本和大小一致。
- 真实静默安装通过，安装版版本 2026.1031.0，独立 Node 24.22.1 与 OpenClaw 2026.10.9 资源核验通过。
- 安装版完整 UI 门禁通过：**92 个场景、11 张截图、一次启动**，覆盖全部主视图和设置 tabs、英文、125%/150% DPI、reduced-motion 与关键交互。报告：`out/ui-release/2026-10-31T06-19-29-203Z/report.json`。
- 归档文档链接检查 18 个文件全部通过，无失效相对链接。
- 最终安装版启动复核：窗口 1.018s、healthz 47.789s、readyz 49.439s、完整可用 56.985s、正常退出 3.656s，`gracefulExit=true`。报告：`out/startup-review/2026-10-31T06-24-49-855Z/report.json`。
- GitHub Release 和公开资产断言结果在发布完成后补充。
