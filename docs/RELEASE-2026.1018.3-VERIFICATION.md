# 2026.1018.3 六轮优化与验收

本轮从 2026.1018.2 开始，按下列六个范围检查、修复与验证。没有将“趋近完美”解释为无缺陷保证；发布以明确的回归与产物门槛为准。

| 轮次 | 检查与发现 | 修复与验证 |
|---|---|---|
| 1 回归基线与隔离 | Vitest 临时缓存、esbuild 临时文件受环境权限影响；ASAR 测试仍写入真实用户目录中的进程锁 | 临时目录移到工作区；ASAR 冒烟同时隔离 HOME、USERPROFILE、LOCALAPPDATA 和状态目录，真实内核启动通过 |
| 2 工作区草稿与导航 | 导航序号在等待备份后分配；放弃草稿的异步续体读取当前文件而非原目标 | 提前分配导航代次；放弃前捕获文件、草稿及代次，在确认和 IPC 等待后复查；异步竞争回归测试通过 |
| 3 Worktrees 列表 | 重叠刷新和连接切换可能让陈旧结果或错误覆盖当前状态 | 每个 state 用 WeakMap 保存请求标记，校验请求与 client 归属；验证旧请求不能清除新请求的 loading 或发布旧错误 |
| 4 更新暂缓 | 写盘失败后 UI 内存已暂缓，但后台检查仍重新读盘；清除失败也会继续被旧文件阻挡 | 启动与周期检查统一消费内存状态；假时钟集成测试覆盖写入失败与清除失败 |
| 5 发布资产一致性 | 只查首个架构；深度校验允许顶层旧 hash 掩盖文件条目 hash 错误 | 校验每条资产、blockmap、大小、SHA-512 格式、重复条目及顶层一致性；允许任意架构排列；深度校验仅接受对应安装器的 hash |
| 6 验收工具可靠性与交付 | HTTP 健康检查只设置 socket 超时而不结束请求；CDP 断线和发送失败可留下永久 pending | 健康检查主动销毁超时请求；CDP 请求超时、断线拒绝及发送失败清理；真实无响应 HTTP 服务与断线回归测试通过 |

## 回归与安装

- `npm test`：**1919 pass / 0 fail / 4 skipped**（Vitest 276、Node 374、Chat UI 1113、scripts 156），包含界面类型检查。
- `npm run dist:win` 成功；ASAR 33388 文件校验、兼容补丁校验和全新 ASAR 启动冒烟 2/2 通过。包内版本 2026.1018.3，内核 2026.10.4，内存暂缓修复已进入 app.asar。
- 安装器、blockmap、latest.yml 同批生成；本地逐条清单验证及安装器 SHA-512 比对通过。安装包未配置 Authenticode 签名，首次安装可能显示 SmartScreen 提示。
- 安装 E2E 首次暴露环境限制：工作区生成的 exe 继承 Low Mandatory Level，进程以低完整性级别运行，无法写入普通安装目录的 uninstallerIcon.ico。文件并非只读，用户 ACL 有 FullControl；普通获准 shell 可写，但安装器完整性 RID 为 4096（shell 为 8192）。按发布流程在普通用户 Temp 创建副本后标签恢复默认，SHA-256 与原包均为 `6cada36f9bdadbc45778955a1e37cb6030b0b4b728f151ee590ba93dce8a42ba`。
- 对普通 Temp 副本运行 `scripts/silent-install.js ... 2026.1018.3`：退出 0，安装位 app.asar 版本确认 **2026.1018.3**。没有修改安装目录权限，也没有忽略安装错误。

## 已安装应用验收

- 严格布局：20 场景，0 issue，0 裸翻译键，0 renderer exception；网关 GET / 返回 200。
- 设置：14 页签，0 重叠、0 裸翻译键、0 renderer exception。
- 交互：8 项断言通过，包含危险确认框 Escape 取消；取消后网关仍为 200。
- 截图：28 张，0 重叠、0 页面横向溢出、0 低对比、0 裸翻译键、0 renderer exception。2 个裁切场景均为无文本的聊天/任务加载骨架。人工复核外观页布局正常。
- 冷启动过程中各脚本记录到 WebSocket 连接失败日志，随后连接恢复；这些连接重试不是 renderer exception，未将 consoleErrors 误写成 0。
- 专用验收会话真实发送消息并调用现有模型，回复「发版冒烟通过」进入 chat.history；0 renderer exception。未改动用户原有会话内容。
- 本地证据（gitignored）：`.cache/goal-final-tests.log`、`goal-build.log`、`goal-fresh-asar.log`、`goal-install-staged.log`、`goal-layout.log`、`goal-settings.log`、`goal-interaction.log`、`goal-ui-qa.log`、`goal-real-chat.log`；截图报告位于 `out/ui-qa/2026-10-18T13-35/report.json`。

发布目标：[v2026.1018.3](https://github.com/binchen6/CryoClaw/releases/tag/v2026.1018.3)。正式发布仍须通过远端 CI、草稿资产断言及转正后的资产断言；状态以该 Release 与关联 CI 为准。
