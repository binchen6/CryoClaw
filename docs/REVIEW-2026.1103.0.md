# 2026.1103.0 人工缺陷与优化审查

本轮以整个产品链路为范围，按职责和信任边界人工阅读关键实现、追踪调用与失败路径，结合定向回归和最终安装验收。自动测试和依赖公告用于核对，不代替人工判定；不声称逐行证明整个项目不存在缺陷。

## 覆盖

| 范围 | 人工核对重点 | 结论/验证 |
|---|---|---|
| 启动与进程生命周期 | gateway-process/gateway-lifecycle 的世代、启动中停止、端口身份、退出与重试；app-gateway、ticker 的连接所有权 | 保留安全终止预算；首次历史/会话优先、旧轮次失效、ready 不打断握手；四层及最终计时/重连验收 |
| 配置、凭据与渠道 | provider-config、atomic-write、config-backup、settings/backup、QQ 扫码所有权和取消、QQ 保存/迁移 | 修复旧 allowlist+通配符 DM 语义；审批名单独立收敛，不扩大权限；扫码凭据留在主进程 |
| Renderer、IPC 与外部打开 | preload、ipc-sender-guard、window 导航、安全打开白名单、workspace-ipc 的根/realpath/argv | 修复文件校验后消失导致非结构化拒绝；编辑器缺失/IPC 失败显示错误；保留禁止 shell 拼接路径 |
| 内置浏览器与 Agent | embedded-browser、gateway-control-server 的 owner、token、限流/正文上限、队列取消和接管 | 保留来源校验、loopback Bearer、请求期限、视图所有权和关闭取消；现有回归与最终安装能力检查 |
| 工作空间、Dock 与全局 UI | 文件预览、调宽、原生与手动菜单、工具/进度/记忆折叠、主题和焦点 | 新增长菜单居中限高及视口变大恢复；保留同源双向动画、懒挂载、inert、反向取消和 reduced-motion |
| Provider、聊天与任务 | provider 分组、真实消息/工具结果显示、历史/会话竞争、cron 所有权、保存中禁用 | 继续使用快照/版本守卫，受控折叠不提前移除内容；全量回归、完整 UI 和真实聊天/重连 |
| 扩展与数据/文件边界 | plugin-store/skill-store 的 argv、超时、ack 兼容；本地导入、归档路径规范化/预算、安全打开 | 保留不自动扩大插件能力、路径穿越与链接拒绝、导入/导出预算；无未经验证的自动依赖升级 |
| 内核布局与更新回退 | compact-typebox-runtime/build-typebox-runtime、工厂安装锁、kernel-update、kernel-directory-swap | 固定源码/API 契约，未知版本保留上游；只操作离线 staging，异常回滚/中断恢复；官方 pin 保持 10.9/Node 24.22.1 |
| 安装与软件更新 | installer.nsh、silent-install、app-updater、app-update-source、release 资产检查 | 同盘 rename 和复制回退保留；安装前确认无活动实例；验收同批 exe/blockmap/latest.yml 与真实更新发现 |
| 网站与维护文档 | 官方下载入口、release-notes、中英说明、CLAUDE/设计规范、当前验证入口 | 网站通过 latest 动态获取版本；README 指向本版；版本元数据与内核清单复核，远端机器人更新先合入 |

## 本轮新增修复

1. **QQ 旧策略迁移可能收紧 DM**：腾讯插件旧 `allowlist + *` 实际允许所有私聊。启动迁移及修改其它账号时将这种原有聊天语义保留为 `dmPolicy=open`，同时移除原生审批名单中的通配符。用户在当前表单明确选择 allowlist/disabled/pairing 时，该选择优先，不被二次规范化覆盖。覆盖根、命名账号、明确策略和幂等回归。
2. **长菜单可能盖住触发器**：上下两侧都放不下时，仅翻转/视口夹取不足以避让。共享纯几何函数收敛可用高度，手动和原生菜单及文件打开方式复用；重新测量前恢复原 max-height，视口变大后不会永久保留旧小尺寸。真实 Electron 覆盖 600/900px 高度、居中触发器和长菜单恢复。
3. **文件打开错误未完整收尾**：路径校验后文件消失时 stat 曾在 try 外抛出，VS Code 缺失等结构化错误也可能被界面忽略。stat 纳入错误契约，打开方式组件捕获 IPC/结构化失败并使用统一错误 toast。保留路径守卫与字面 argv。

验收与规范维护也进行了修正：窄窗测试在改变主题前保存原始设置，结束时恢复尺寸覆盖和临时引用；中文历史字段规范的旧焦点环与输入卡例外已改为现行统一令牌，中英文均登记全局交互规则。

## 依赖公告与边界

审计快照为本轮 npm audit 原始 JSON：`.cache/release-1103-{root,ui,production,gateway}-audit.json`。应用自身生产依赖与 UI 为 0；根工程含开发工具的图有 15 个中危项，网关安装图有 33 个中危项，无 high/critical。按依赖节点计数不等于 48 个独立可利用漏洞。

本轮核对了上游 [glob 取消后仍遍历](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) 和 [minimatch 模式放大](https://github.com/advisories/GHSA-g3hv-75wg-m249) 公告。修复版本分别为 glob 14.0.2、minimatch 11.0.1；当前受影响的旧主版本没有本轮查到的同主版本修复。人工追踪到构建打包/工具链的 glob 模式，以及网关附带 npm/工具链传递图；未发现本次改动增加的未认证外部模式输入到这些库的调用路径。这不是“零风险”结论，DoS 公告仍保留在报告中。为满足兼容与维护优先要求，不对 Electron 打包器或固定内核全图强行跨主版本 override，也不把修改审计结果当作修复。

## 验收记录

本轮定向 QQ、长菜单、文件错误、内核更新/回滚/工厂锁回归通过；真实 Electron 长菜单、双向折叠、聚焦、调宽和减少动态效果通过。最终发版四层、安装、性能、动态能力、UI、真实聊天、公开资产和 push 的完成状态统一记录于 [发版验收](RELEASE-2026.1103.0-VERIFICATION.md)。前一轮 2026.1101.0 本地候选结果不冒充新版本最终安装证据。
