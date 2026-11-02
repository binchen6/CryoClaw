# 2026.1101.0 验证记录

最终本地验收已完成。公开发布与资产状态以 [v2026.1101.0 Release](https://github.com/binchen6/CryoClaw/releases/tag/v2026.1101.0) 为准；本记录对应随版本标签保存的源码及下列精确安装产物。

## 改动与审查

保留 Electron WebContentsView、Lit UI 和独立 Node 24.22.1/OpenClaw 2026.10.9。接续 533d9e9 合入的 Dock/浏览器功能，根依赖未增加；QQ Bot 的上游生产依赖随插件物理打包。

- 浏览器：多标签、页内查找、打印、缩放、设备预览、截图、本次运行的历史/下载、清理与设置。标注支持十字指针、悬停框选与名称标签、自然过渡、元素避让、Selector/XPath、类名复制/插入评论、几何/语义/捕获信息与截图引用。
- Agent：共享真实网页、唯一选择器、原生输入/选项事件、截图图片、授权即时撤销、HTTP 取消、队列顺序和有界等待。快照隐藏密码值并限制输出；长 URL 不再卡死快照。菜单通过截图占位避开原生视图层级；标注绑定来源标签和会话。
- debug 审查：覆盖 IPC、gateway、provider/setup、安装更新、备份、workspace/Git、附件和生命周期。修复字面 Git 路径、重命名/复制取消暂存、子目录基准、可信程序路径、Windows 终端启动、HTTP 断流/整体时限及 SDK URL 语义；附件检查反向链接、fd 身份和读取上限。
- 优化审查：历史请求按 client/session 目标协调，父子会话互不覆盖，渐进展示与失败刷新正常；流式投影保留历史引用。统计请求按业务版本合并，一次仅一份在途请求，失败可重试；同路径后续编辑、撤销与过期缓存均能更新。
- QQ Bot：固定腾讯官方 `@tencent-connect/openclaw-qqbot@2.0.4`；插件 ID 迁移为 `openclaw-qqbot`，渠道键保持 `qqbot`。支持手机 QQ 扫码、多账号、Markdown、私聊流式、群聊 @、媒体 URL、访问策略与 Webhook。凭据只在主进程合并保存，取消、过期、窗口销毁和迟到回调均有守卫；保留现有禁用/deny 与访问名单。托管 SDK 来源和升级路径固定到应用，修复 connector 1.2.0 缺失 CommonJS 发布边界。
- Kimi：删除过时思考档位补丁的实现、构建/更新调用与旧断言，保留原生 provider 行为。

独立审查记录与红绿日志保存在 `.cache/`，关键路径均有新增行为回归。初次源码回归在 Windows 沙箱的 realpath EPERM 阶段失败；普通用户重跑通过。环境失败不计为产品通过。

## 当前源码门禁

- 最终四层 `npm test`：2860 passed / 6 skipped / 0 failed，27.1 秒。Vitest 347、Node 476/4 skipped、Chat 1549、Scripts 488/2 skipped。
- 构建、UI 类型检查和 `git diff --check`：通过。
- 独立 renderer 关联测试：293/293；后台 focused Node 148/148、Chat 42/42、Vitest 15/15。
- 隔离 Electron 浏览器：14 项通过，含悬停指针/名称/过渡、原生表单事件、菜单、设备、标签保活、标注避让/评论/截图、跨会话与跨标签取消、前台关闭恢复及接管。报告：`out/browser-qa/2026-11-01T15-00-24-472Z/report.json`。
- 最终浏览器复核：`out/browser-qa/2026-11-01T15-17-03-503Z/report.json`，14 项通过。
- 最终构建复测捕获首次空白页与 Agent 导航竞争：两条新增并发回归先失败再通过，按每标签导航代次防止重复初始化和旧 abort 停止新请求。修后真实浏览器 14 项全部通过：`out/browser-qa/2026-11-01T23-42-41-670Z/report.json`，独立增量复核未发现阻断。
- 真实界面补查：修复 Lit 原型响应式字段被对象展开丢弃而导致真实发送崩溃；原型访问器回归先失败再通过。工具展开状态现在通知所属历史/流式组件，避免被性能门控跳过；此前界面点击超时，修后 `reference-ui-smoke` 全部通过，包含四组宽窄/明暗、发送/停止、12 项可配置快捷键搜索、命令过滤、单工具展开和高亮内容更新。报告：`out/ui-qa/reference-refinement/report.json`。独立复核未发现阻断问题。
- QQ 后台相关 134 项通过；固定 Node/OpenClaw 的真实 registry 加载官方 preload、注册 qqbot 渠道和工具，diagnostics 为空。真实官方 connector 生成本地 SVG 二维码并取消，0 次配置写入/重启。
- QQ 隔离 Electron 10 项通过：SVG 刷新/取消、过期/失败、名单换行、账号范围保存、网关重启恢复、切账号保留脱敏快照、新账号实际选中、390px 无横溢出、离开清理与单在途轮询；零 console/runtime 错误。报告：`.cache/qqbot-ui-qa/report.json`。真实手机未扫码；不将模拟绑定或预扫码计为真实账号授权/QQ 消息投递。
- 最新 Dock：删除收起竖栏和占位，仅保留标题栏右上入口；展开使用可关闭 chip tabs、居中入口和真实快捷键，保留新增/最大化/收起。消息、命令、进度、附件和输入框一起避让，Dock 贯穿内容区。1440/800 实际几何、拖动分隔线与比例保存、最大化/恢复、最后标签关闭返回入口均通过。报告：`out/ui-qa/reference-refinement/report.json`；截图 `dock-launcher.png` / `dock-launcher-800.png`。
- 文件页真实懒加载目录树、搜索、刷新和预览隔离视觉 9 组通过；800/390 无整页横溢出，旧根迟到响应被丢弃，零 console/runtime 错误。树最多 800 个节点/12 层；工作区可视版本与稳定回调避免无关聊天帧重绘。报告：`.cache/dock-files-ui-qa/report.json`。改变文件路径先处理草稿；修复新文件导航仍被旧工具输出模式遮挡，定向先红后绿。
- 最新原生浏览器 16 项通过，新增外层 Dock 菜单覆盖原生页、单页精简栏新建真实网页和动画后视口坐标对齐检查。最终正常渲染报告：`out/browser-qa/2026-11-02T12-00-43-817Z/report.json`。快速隔离启动曾出现 Electron `UnknownVizError`，失败记录保留，未降低截图断言或改变产品渲染设置。
- 用量圆环：28px 透明按钮、20px/1.5px 细线，不显示常驻数字。四组宽窄/明暗真实渲染与比例、无数字、键盘聚焦详情和同入口开合通过；沿用实际 token 统计和告警。报告：`out/ui-qa/reference-refinement/report.json`。
- 启动：保留服务端重试元数据、普通网络退避与真实准入；首次/重连单次历史和会话读取。独立审查发现并修复长历史渐进投影、失败提示与旧连接覆盖；61 条按 20→60→61 展示且只发一次 RPC。31 项定向测试和终审通过。渠道库存子进程共享版本/构建专属编译缓存，QQ 自动版本预热关闭而手动检查保留。完整测量口径与结果见 [启动记录](STARTUP-2026.1101.0.md)。

## 行为边界

浏览器的 cookie/storage 使用独立持久 partition；历史与下载列表只记录本次应用运行，下载文件不会因清理记录被删除。截图只在用户确认加入输入框后成为消息附件。接管会停止等待中的导航并拒绝后续 Agent 命令；已经交付给网页执行的脚本或已提交的网络请求无法普遍回滚，不以强制重载损坏用户表单来模拟撤销。

## 安装与公开发布

最终来源已重新打包并精确静默安装，安装模式 `rename`、无 fallback，单次安装 117.61 秒。构建与安装位 app.asar SHA-256 均为 `7c5784a48a723022cd1f8ad7b86cc9e01ce4c9faa26a4ff26e0e6371be11cd9f`。Node 24.22.1/OpenClaw 2026.10.9、QQ 2.0.4、托管 bundle SHA、connector CJS 边界、旧 QQ vendor 缺失、七个 Kimi JS 文件无旧补丁和浏览器工具注册均通过。

仓库远程更新频道已同步 `stable=2026.10.9`、`minRuntimeNode=24.22.1`、`updatedAt=2026-11-02`，`minSupported=2026.7.0` 保留。该元数据从仓库 main 读取，不进入安装包；包内更新器兜底早已由 package.json 注入 10.9，因此本次元数据修正不改变下列安装产物。清单解析、旧 Node 拒绝门槛和既有更新器回归已复核。

- 安装版完整 UI：96 场景、11 张截图、renderer 异常为零，耗时 220.3 秒。报告：`out/ui-release/2026.1101.0-final/report.json`。保留启动连接阶段的 WebSocket 诊断，不宣称 console 错误条数为零。
- 安装版 QQ：实际官方 connector 生成本地 SVG，取消后配置哈希不变，renderer 异常为零。报告：`out/installed-qqbot-qa/report.json`。手机未扫码，不计为真实账号授权或 QQ 消息投递。
- 安装版真实 Agent：读取页面独有随机码，完成输入和点击，确认真实 DOM 变化及接管撤权；同调用 ID 的 code-mode 执行结果、终态 nonce、三个主进程 Agent 事件共同验证。报告：`out/installed-browser-qa/2026.1101.0-final/report.json`。真实模型独立会话的 nonce 回声亦进入持久历史；专用 QA 会话均已删除。
- Windows CMD/Git Bash：实际启动在含 ` [&] ` 的专用空目录，原生只读 PEB 检查确认 cmd/bash/mintty 的真实 cwd；仅清理本次进程和空目录。未通过 GUI 输入命令，未更改 PowerShell 执行策略。报告：`.cache/installed-terminal-qa.json`。
- 三轮启动对照的身份校验和正常退出通过，完整可用中位 134.36→95.14 秒；完整固定工作流 147.59→101.58 秒。缓存限制和全部样本见 [启动记录](STARTUP-2026.1101.0.md)。

QA 修复保留失败证据：定时表单合成错误被真实全局轮询清除，夹具使用已有读取守卫隔离后完整 96 场景通过；工具折叠点击改为当前真实入口。Agent 的直接名字与源码字符串断言也曾误拒两次实际成功调用，已改为原生事件、DOM 和终态证据，八项正反回归及独立审查通过。这些均为安装包外的 QA 改动，产品源码和安装产物没有变化。

已知限制：额外的“启动尚未完成便退出”检查触发既有约 60 秒终止保底，不计为正常退出收益；就绪后三轮退出均明确 cleanly。未缩短保护预算或修改内核来掩盖。当前无本次 QA 遗留的应用、网关或临时终端进程。

| 同批 Windows x64 资产 | 大小 | SHA-256 |
|---|---:|---|
| `CryoClaw-Setup-2026.1101.0-x64.exe` | 316,450,718 bytes | `f1dc5096a8ee5e542831f8b3c9dfe916211c611f1bf37d8dd023ea4d0fa4dc0f` |
| `CryoClaw-Setup-2026.1101.0-x64.exe.blockmap` | 326,397 bytes | `2a70c27a1bd3ec9b879e25de95cef26ddb9a09cdb1affc29099790304a2feb09` |
| `latest.yml` | 371 bytes | `8453db253a884d9b6dd5a94b77bf73a5ca37871e25f0dd593774f36523a0f2e1` |

发布流程继续校验草稿远端三件套与本地哈希、公开 latest 指向及真实 SDK 更新发现，再推送 main；公开资产状态以版本 Release 为准。
