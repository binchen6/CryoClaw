# ChatGPT / Codex 订阅登录

当前实现接入捆绑 OpenClaw 2026.10.3 的原生账户协议。独立测试账户已完成浏览器授权，原生状态返回 OAuth 可用、11 个可用模型及 Plus 的 5 小时/每周额度窗口。

## 数据与状态归属

- OpenAI / Codex 独立代理保存在 CryoClaw 专属配置 `openaiProxy`，不会改系统代理、环境变量或其他提供商配置。支持环境、直连和不含认证信息的 HTTP(S) CONNECT 代理。保存明确触发网关重连，登录期间禁止修改。
- 网关启动时加载壳层拥有的代理引导模块，固定路由 `auth.openai.com`、`api.openai.com`、`chatgpt.com`、`api.chatgpt.com` 的 HTTPS 标准端口请求，覆盖应用内 OAuth、额度查询和模型 HTTP 请求；自定义 API 域名及外部浏览器不在此范围。TLS 验证保持开启。
- 代理的 fetch 与 dispatcher 来自同一个捆绑 undici，避免 Electron 内置 fetch 的 dispatcher-handler ABI 不匹配。代理测试仅检查到授权主机的 CONNECT 隧道，不声称登录成功或服务地区可用。
- 令牌交换的 SSRF guard 会直接调用内核 undici，绕过全局 fetch。因此引导模块同时接管全局 fetch 和捆绑 undici 的 fetch 导出，均按固定域名路由；在内核读取运行时快照前安装。原生 `exchangeOpenAIAuthorizationCode` 已用无效测试参数及本地拒绝隧道确认经过代理，未读取用户授权码。实际请求仅按首次出现记录域名与路由模式，不记录 URL 查询、请求体或凭据。
- 账户模型选择器从内核 `models.list(view: configured)` 合并可用的 OpenAI 模型，无需伪造 API Key 或创建重复 provider 条目；同步后联动聊天、任务选择器。

- 登录方式来自 `models.authStatus.providerCapabilities[].loginOptions`，按内核声明显示，不硬编码模型清单或 OAuth 客户端参数。
- `models.authLogin` 使用客户端生成的 `sessionId` 和内核返回的 `authChoice`。向导通过 `wizard.next` 推进，通过 `wizard.cancel` 关闭；等待登录允许最长 15 分钟，避免普通 30 秒 RPC 超时截断授权。
- 内核保存、刷新 OAuth 凭据并应用模型权限；渲染层不读取 auth-profiles 文件，不把订阅令牌当 API Key 保存。
- 登录完成后调用 `models.authRefresh(operation: login)`，再读取认证状态、`models.list`、`usage.status` 和配置快照。首次登录可能将共享凭据从 agent DB 迁入 state DB，而目录 worker 仍持有旧归属；仅在向导成功但未返回账户时自动重连一次，保留凭据，不要求再次授权。
- 额度来自原生 `usage.status.providers[].windows`，并兼容认证状态中的缓存额度。`usedPercent` 为已用百分比，`resetAt` 为毫秒时间戳；缺失额度和服务错误明确显示，不当成零余额。
- 登录后显示账户概览、额度与模型管理，重新登录入口收起；代理默认折叠。账户模型支持显示名称、默认项、流式输出和高级 JSON 参数，写入原生 `agents.defaults.models` / `model.primary`，保留其他模型与权限。上下文及输入能力来自内核，不伪造 API Key。模型设置保存后自动收起，仍可手动展开或折叠。
- 用户明确启用内置 OpenAI 提供商时，通过现有配置补丁通道更新 `plugins.entries.openai.enabled` 和已有 `plugins.allow`，保留其他允许项。原来没有 allow 列表时不创建新的限制列表。
- 授权链接只允许无用户名/密码的 HTTPS `auth.openai.com`、`chatgpt.com`；文本步骤临时输入在推进或取消后清除。

## 已验证

- 本地真实 undici 代理测试确认登录、用量、模型三个域名经过 CONNECT，普通回环请求不经过代理；配置校验、域名隔离、直连和环境模式有回归覆盖。
- 旧测试窗口缺少 sessionId 的报错已修复。令牌交换曾绕过全局 fetch，导致独立代理无效；接管捆绑 undici 后用户确认登录正常。脱敏原生 RPC 验证账户状态、可用模型和额度均已返回。
- 2026.1016.0 中间候选已完成 NSIS 构建和静默升级，安装版本一致；加入独立代理后的 2026.1017.0 必须重新打包验收，不能复用此前安装结果。

- 前端类型检查与 972 项测试通过；全量测试各层通过 268 / 333 / 972 / 143 项，另有 4 项 Node 测试跳过。Rust 归档后端 10 项通过。最终安装和界面验收结果见进度文档。
- 独立 Electron 状态 `.cache/ui-smoke-state` 下，初始 allow 列表确实缺少 OpenAI；经配置补丁启用后，内核返回 `openai/openai-device-code`、`openai/openai`、`openai/openai-token-sharing`。
- 同一持久网关连接上完成向导启动、读取 progress 步骤及 closeInput 取消，未提交账户凭据。
- 离开模型页会取消在途向导并清除临时输入；取消后的迟到启动响应不会自动推进新会话。该取消竞态已有回归测试。
- GitHub 沙箱内的认证失败提示不可靠；沙箱外 `gh api user` 返回 binchen6，仓库 push 权限为 true。

## 发版前仍需完成

登录流程遵循内核向导协议：`progress` / `executor: gateway` 自动推进，说明类 note 自动确认，只有输入和选择需要用户操作。官方链接及设备码跨步骤保留。浏览器回调轮询不提交空答案；推进或取消时清理轮询。启用提供商前强制刷新配置快照，重连后自动同步。

1. 真实账户已验证授权、模型与额度；长期令牌到期后的续期由内核负责，本轮未人为修改真实凭据模拟过期。
2. 模型页视觉和键盘验收、切页时向导生命周期审查。
3. 全项目代码审查及最终回归；同步版本号、双语发布说明和文档。
4. Windows 打包与安装验收，通过后提交、push、发布安装包。

## 官方参考

- [Codex Authentication](https://developers.openai.com/codex/auth/)
- 本地协议事实来源：捆绑内核 `models-auth-login`、`models-auth-status`、`wizard`、`model-provider-capabilities` 和 OpenAI provider manifest；内核源码仅取证，未修改。
