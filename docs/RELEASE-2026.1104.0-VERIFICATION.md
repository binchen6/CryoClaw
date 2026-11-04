# 2026.1104.0 发布验收（本地完成，发布中）

用户已恢复任务并授权继续 debug、优化、发版和push。1103为未发布历史候选。main已快进合入e2be0f0的独立WebBridge镜像与钉定更新，SHA256匹配；该提交未改动本次安装包输入。本轮尚未提交、创建tag或公开发布，不将草稿/本地包视为完成。

## 固定来源

- OpenClaw2026.10.10、六个官方插件同版；Node24.22.1、Electron43.8.3、QQ2.0.4。稳定通道与工厂安装锁同步；fs-safe保留上游精确0.26.5。
- [内核升级审查](KERNEL-2026.10.10.md)、[启动调查](STARTUP-2026-11-04-INVESTIGATION.md)。七处旧补丁退役，旧内核适配保留；新缓存启动协议不改内核源码。
- 用户数据库已完成一次迁移，原生恢复备份和独立一致性备份均保留。迁移后的旧内核读取拒绝边界已验证，不自动覆盖用户状态做降级。

## 已完成

- 最终来源四层完整回归通过：`.cache/release-1104-tests-post-ready.log`，23539ms；2916通过、6跳过、0失败。含真实IPC异步清理/自然退出、原生命令模块链接、数据库版本边界、WAL回退准入、缓存交接及启动后单次技能刷新。
- 上游真实缓存协议验证：`.cache/kernel-2026.10.10/cache-protocol.log`；主线程缓存关闭、无需respawn、工作线程实际缓存开启。
- 真实TypeBox1.3.35运行模块703→17，固定源码指纹及公开导出/共享身份/验证行为对照通过。
- 交互专项11组全部通过：`out/interaction-ui/release-1104-on-demand/report.json`；人工查看截图，底部菜单围绕触发器展开且未越界，焦点和分隔线共享全局样式。覆盖工具卡片指针/键盘焦点、390px、长菜单限高恢复、双向折叠反转和reduced-motion。
- 依赖公告：前端生产0；根15中危、网关工具图33中危，无high/critical。相同冻结依赖图的公告记录在`.cache/release-1104-*-audit.json`，未为追求清零盲目跨主版本覆盖。
- 最终构建通过：`.cache/release-1104-build-on-demand.log`；精确静默覆盖安装通过，编排日志`.cache/release-1104-final-gates.log`，脚本墙钟127824ms。实际安装记录payloadMode=entry-rename、fallback=none、installMs=125234；不与不同来源历史候选比较安装收益。安装资源Node24.22.1、内核10.10及updater fallback/通道pin全部匹配。
- 真实安装版技能生命周期通过：`out/skills-status-profile/release-1104-final/report.json`。身份、历史和会话可用后才发出一次refresh；65秒无重复自动刷新，外部测试技能未被后台发现；实际按钮刷新能发现新增并移除删除的技能。测试目录已清理、原视图已恢复、正常exit0、零renderer异常，已人工查看技能页截图。
- QQ隔离设置UI通过：`out/qqbot-ui/release-1104-final/report.json`，多账号、旧策略、扫码取消/重试/离页、390px及异常检查；未写真实渠道凭据。

## 最终安装版三轮启动

`out/backend-performance/release-1104-final/report.json`，ok=true。安装ASAR SHA256 `fc97f80fe08b3ee31f5b8cc3243acf32d0b9bd7080dfe35d32a6a0028d527519`；Node SHA256 `d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5`。缓存策略为安装验收之后的既有缓存、未重置；三轮配置指纹相同，不是冷系统缓存实验，不与历史不同来源报告计算降幅。

| 指标 | 最终观测 |
|---|---|
| 认证、历史和会话可用 | 62.591 / 61.326 / 62.462秒；中位62.462秒 |
| Gateway ready中位 | 56.982秒 |
| 首次完整RPC批次中位 | 11.298秒，主要为首次原生命令目录加载 |
| 固定工作流含退出中位 | 86.392秒 |
| 稳态RPC p50 / p95 | 1.7 / 412.5ms；命令目录p95为518.7ms，其余接口p95为2.7–4.6ms |
| 退出 | 2.497 / 2.876 / 2.996秒；应用和实际网关全部正常exit0、无强杀 |
| 进程归属 | 每轮端口实际PID与应用持有/采样的独立Node PID相同 |

仍约一分钟，不能宣称秒开。用户首次10.10数据库迁移448860ms为单独的一次性升级成本，原生恢复备份和独立备份均保留。

## 页面与真实能力

- 三轮36页面首次导航/回访全部成功（216次终态），`out/frontend-page-performance/release-1104-final/report.json`，pagesSuccessful=true，ASAR哈希与后端相同。技能页中位666.9/637.2ms，最大721.1/650.3ms；每次一次原生状态读取，没有长任务或15秒假超时。首次导航包含已有预取/缓存，不能称作冷系统缓存。
- 扩展主入口首次中位14.831秒、回访96.9ms；部分记忆页仍有数秒原生读取。没有用子页快速回访掩盖首次发现成本，完整逐页数据保留在报告中。
- 完整安装UI 96场景通过，`out/ui-release/release-1104/report.json`；覆盖明暗、宽窄、DPI、减少动态效果、中英文及MCP/确认取消/上下文/任务/工具卡片。已人工查看聊天、工作空间、诊断、菜单和窄屏Dock截图。
- 工作空间与Dock宽屏/800px：`out/ui-release/release-1104/workspace{,-narrow}/report.json`均ok=true，菜单锚点正确、不覆盖触发器；字段共享令牌，拖动transition=0s，拖动中零写入，释放一次提交；原设置和视口已恢复。
- 腾讯QQ真实预扫码/取消通过，`out/ui-release/release-1104/qq-prescan/report.json`；真实本地SVG二维码、取消后配置哈希不变、零renderer异常。未执行真实账号绑定或渠道对外发消息。
- 实际浏览器Agent通过，`out/ui-release/release-1104/browser-agent/report.json`；有原生Agent打开事件、工具调用/结果配对、nonce回复和实际DOM输入/点击效果，接管撤销策略。不是仅检查模型回复文本。
- 真实聊天返回唯一nonce并持久保存，`.cache/release-1104-final-gates.log`及其已完成steps中均记录成功；专用QA会话已按脚本清理。

验收编排在最后的重连计数读取处遇到临时脚本错误：中英文测试重载页面清掉了JS计数器。独立功能报告均已通过；保留`.cache/release-1104-acceptance-instrumentation-failed.json`，不把该失败改写成通过。单独重连与后续门禁见最终补充记录。

完整真实任务后的退出墙钟59574ms，原生清理58682ms后正常exit0，无强杀。原生日志提示plugin-services超过5秒预算后继续等待其资源完成；memory-preparation/plugin-services/cleanup-work约52–58秒才join。空闲三轮2.5–3秒不能代表这种任务后退出，不缩短原生清理预算掩盖长尾。

## 最终补充验收

- 重连独立补验`.cache/release-1104-reconnect.json`：初始refresh=1，原客户端stop/start并完成新hello、历史和会话准入后仍为1，零错误，正常退出2836ms。原计数器重载失败记录保留，已完成的独立UI/实际能力结果按同一ASAR汇总，不改写失败日志。
- `.cache/release-1104-artifacts.json`：32600个安装资源逐文件SHA256与最终win-unpacked一致，189个dist/Chat UI/shared构建文件与安装ASAR字节一致，package cryoclaw与release-notes一致。
- 10.10实际QQ host schema四种DM策略全部通过，旧通配符配置仍被原生拒绝：`out/qqbot-ui/release-1104/host-schema.json`。
- 启动3秒时直接退出：`.cache/release-1104-early-exit.json`，尚未连接，60921ms后应用exit0；网关触发原有60秒强制终止保底，**不是优雅退出**。保留此限制，不把空闲退出结果替代启动中停止。
- 实际electron-updater使用公开1101原安装器作基线，差分/损坏blockmap回退/全量三项均通过最终文件哈希：`out/update-download/release-1104-{differential,fallback,full}.json`。差分安装器响应106767682B，全量324349824B；均为本机无节流下载验证，不宣称公网耗时。

| 同批公开资产 | 字节 | SHA256 |
|---|---:|---|
| CryoClaw-Setup-2026.1104.0-x64.exe | 324349824 | `18ca40ff40a514acbe969b4acd9ca4d4858672ebf14c3cdbcf67bdd2a12452b3` |
| 同名.exe.blockmap | 335391 | `0600a0bebeb28ad645928ba61778c843140eaf26f4fe279fe558a8932f450979` |
| latest.yml | 371 | `4d9b42a012147d6a4502ff033c0ab85901c5d5d740afaabecfdca48bc095dbbf` |

本次安装器未配置代码签名，构建检查明确提示，未绕过校验。剩余发布门禁为草稿服务端资产核对、公开latest/更新发现及远端main；通过后补充状态。

历史初步候选在命令接口及启动器归属上发现的问题均已记录。受控fs-safe两组已标为diagnostic，不能挪作本版本正式性能证据。
