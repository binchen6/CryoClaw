# openclaw 2026.8.2 内核调研与 CryoClaw 适配点矩阵

调研日期：2026-09-03。信息来源：GitHub Releases API（openclaw/openclaw v2026.8.2 / v2026.8.1 release notes 全文）、npm registry 实测（`npm pack openclaw@2026.8.2` 62MB 真实产物解包验证）、docs.openclaw.ai。产物留存于 `.cache/kernel-recon/`（gitignored）。

## 1. 版本线与运行时

| 项 | 结论 |
|---|---|
| 最新稳定 | **2026.8.2**（2026-09-01 发布，npm `latest`） |
| 2026.8.1 | 即 "OpenClaw 2.0"（2026-08-31），2.0 大版本 |
| engines | `node >=22.22.3 <23 \|\| >=24.15.0 <25 \|\| >=25.9.0` |
| CryoClaw 捆绑 Node | package-resources.js 取 nodejs.org 最新 v22，实测当前为 **v22.23.2 ≥ 22.22.3，兼容**，无需改 Node 选型 |
| WS 协议 | **仍为 protocol 3/4**（dist 实测：`minProtocol > 4 || maxProtocol < 4` 拒绝逻辑）。chat-ui 的 `minProtocol:3, maxProtocol:4` **无需改动** |
| config.get/patch | `REDACTED` 哨兵、`baseHash`、`sessionDefaults` snapshot 均在 2026.8.2 dist 中存在，契约无变化 |

## 2. 2026.8.2 新功能（相对 2026.7.1-2）

1. **Home agent 停靠面板**：Cmd/Ctrl+Shift+H 右侧/底部 dock，工作上下文快照预览/移除，选中文本附加到消息
2. **后台会话**：New Session 页 Cmd/Ctrl+Enter 直接创建运行（local/cloud/配对设备放置），完成通知可点开
3. Linux 桌面端（.deb/AppImage）——CryoClaw 无义务跟进
4. 无 Gateway 浏览器控制：Chrome 扩展唤醒本地 standalone relay（需更新 native host + 扩展构建）
5. Control UI 四款新主题（CRT/Manuscript/Rosé/Miami）+ 主题离线保存无闪烁
6. 会话组织：动作分组菜单、transcript 复制为 Markdown、会话 tab/窗口/分屏打开、图标颜色编辑、隐藏空会话组
7. 跨会话转发消息独立气泡渲染（来源会话链接 + 发送者身份）
8. 升级安全：保留更新配置、会话迁移不完整中止、失败恢复、`openclaw update cleanup --dry-run`
9. 语音/Talk/MCP 响应限制/补丁保真等大量修复

## 3. 2026.8.1 (2.0) 破坏性/重大变更

- **BREAKING**: OpenProse 插件与 `/prose` 移除（CryoClaw 仓库无任何 openprose 引用 ✓，用户存量配置由上游 doctor 处理）
- **BREAKING**: `codex/*`、`openai-codex/*` → `openai/*` 模型路由迁移（CryoClaw src 无 codex 引用 ✓，用户存量由上游迁移）
- 官方 provider 拆分为独立安装包（iMessage/Cohere/Meta/DuckDuckGo/Voyage 等 14 个不再随内核捆绑）
- Plugin SDK 旧 subpath（config-runtime/channel-reply-pipeline/channel-lifecycle/channel-message/infra-runtime）弃用但 **2026.8.2 中仍可用**（exports 实测 5 个均存在，共 322 个 plugin-sdk 导出）
- `tools.sessions.visibility` 默认值放宽（同 agent 跨会话可见）
- 新默认行为：Active Memory 召回、Dreaming、自动自学、会话不按日重置、CPU 缩放并发 8-16、`modelPolicy.allow`、命名 agent

## 4. 补丁层实测（kernel-dist-patch.js marker 对 2026.8.2 真实产物逐个验证）

| # | 补丁 | 2026.8.2 命中 | 说明 |
|---|---|---|---|
| 1 | openBoundaryFileSync | MISS | 2026.4.x 世代函数，已不存在，预期行为 |
| 2 | openVerifiedFileSync | MISS | 同上 |
| 3 | openRootFileSync | **HIT** (root-file-DJGGfXq8.js) | ✓ |
| 4 | openRootFile (async) | **HIT** (同文件) | ✓ |
| 5 | verifyStableReadTarget | **HIT** (regular-file-CbpO--0m.js) | ✓ |
| 6 | openPinnedFileSync | **HIT** (pinned-open-DhaBotzA.js) | ✓ |
| 7 | sameFileIdentity | **HIT** (file-identity-CaVBmM56.js) | ✓ |
| 8 | auditOpenClawPeerDependency | **HIT** (plugin-peer-link-CijC8-mZ.js) | hostRoot 参数不变 ✓ |
| 9 | linkOpenClawPeerDependency | **HIT** (同文件) | hostRoot 参数不变 ✓ |
| 10 | installedPackageNeedsOpenClawPeerLinkRepair | **MISS — 上游已删除该函数** | 2026.8.2 改为 `reconcileRegisteredOpenClawHostLinks`（mode:"repair"），其审计走 `auditOpenClawPeerDependencyLink`→`auditOpenClawPeerDependency`（补丁 8 覆盖），修复走 `linkOpenClawPeerDependencies`→`linkOpenClawPeerDependency`（补丁 9 覆盖）。asar 下补丁 8 返回 null → 不触发修复。**补丁 10 对 2026.8.2 废弃但需保留给 2026.7.x** |

结论：现有 marker 集合对 2026.8.2 **直接可用**，补丁 10 miss 需豁免（它本就是版本世代补丁，miss≠失败；但 package-resources.js 当前把 patchAsarBoundaryCheck 返回 0 视为失败——只要 3-9 任一命中即非 0，无风险）。

## 5. kimi 思考档位补丁 —— 需要新形态（关键适配点）

- 2026.8.2 内核包**不再捆绑** kimi 扩展；CryoClaw vendor `@openclaw/kimi-provider@2026.8.2`
- 新包结构：`dist/index.js` 变为 ESM wrapper，`resolveThinkingProfile` 移至 **`dist/provider-policy-api.js`**，签名为 `resolveThinkingProfile({ modelId })`
- 上游 2026.8.2 已原生支持 K3 全档位，但**硬编码 model ID 白名单** `["k3","k3-256k","k3[1m]"]`；非白名单模型仍返回二值 [off, on]
- 内核侧 `resolveThinkingPolicyContext` 仍透传 `compat`（thinking-BTUdwSdN.js），且内核新增 `appendCatalogAdvancedThinkingLevels(profile, context.compat, ...)`——**但 plugin 返回 profile 时会短路**，catalog compat 永不生效。因此 CryoClaw 用户自定义模型条目（compat.supportedReasoningEfforts）仍需补丁
- **适配策略**：对 kimi-provider@2026.8.2 的 `provider-policy-api.js` 增加新 marker（`function resolveThinkingProfile({ modelId }) {`），改为读 `context.compat.supportedReasoningEfforts` 优先、回退上游 K3/二值逻辑；旧 marker（2026.7.1 包形态）保留
- 热更新 carryOver 路径：旧 kimi 2026.7.1 插件被搬入新内核 → 旧 marker 继续生效，向后兼容 ✓

## 6. 打包 allowlist 差异（package-resources.js 必须更新）

| 项 | 2026.7.1-2 | 2026.8.2 实测 | 动作 |
|---|---|---|---|
| skills/canvas | 存在 | **移除**（变成 dist/extensions/canvas 扩展；CryoClaw UI 仅 tool-display.json 有名字符串，无功能依赖） | 从 OPENCLAW_SKILLS_ALLOWLIST 删除 |
| skills/discord | 存在 | **移除** | 从 allowlist 删除 |
| skills/imsg（darwin） | 存在 | **移除** | 从 OPENCLAW_SKILLS_DARWIN_ONLY 删除 |
| dist/extensions/shared | 存在 | **移除** | 从 OPENCLAW_EXTENSION_ALLOWLIST 删除 |
| dist/extensions/imessage | 存在 | **移除**（2026.8.1 起为外部官方插件；CryoClaw 渠道面无 iMessage） | 从 allowlist 与 REQUIRED_OPENCLAW_BUNDLED_EXTENSIONS 删除 |
| skills/ + dist/extensions/ 目录本身 | 存在 | **仍存在** ✓ | carryOverInjected 搬运目标无需改 |
| 5 个 provider + feishu 2026.8.2 包 | — | 均含 openclaw.plugin.json ✓ | 钉版更新即可 |

## 7. 插件版本钉（npm 实测）

| 包 | 当前 pin | 2026.8.2 适配 |
|---|---|---|
| openclaw | 2026.7.1-2 | **2026.8.2** |
| @openclaw/kimi-provider | 2026.7.1 | **2026.8.2** |
| @openclaw/moonshot-provider | 2026.7.1 | **2026.8.2** |
| @openclaw/zai-provider | 2026.7.1 | **2026.8.2** |
| @openclaw/qwen-provider | 2026.7.1 | **2026.8.2** |
| @openclaw/deepseek-provider | 2026.7.1 | **2026.8.2** |
| @openclaw/feishu | 2026.7.1 | **2026.8.2** |
| @openclaw/qqbot | 2026.7.1 | **保持 2026.7.1**（无新版；其实测未引用弃用 subpath，且弃用 subpath 在 2026.8.2 仍存在，兼容 ✓） |
| @wecom/wecom-openclaw-plugin | 20206.7.201 | **2026.8.17** |
| @tencent-weixin/openclaw-weixin | 2.4.6 | **2.4.8** |
| @dingtalk-real-ai/dingtalk-connector | 0.8.24 | **0.8.25** |
| OfficeCLI（GitHub iOfficeAI/OfficeCLI） | 1.0.143 | **1.0.147**（与内核无关，顺手升级） |

## 8. 热更新 / 回退链路结论

- kernel-update.mjs 的换装/备份/回退机制不看版本号，**天然支持 2026.7.1-2 ↔ 2026.8.2 双向**
- carryOverInjected 会把旧树注入物（含 2026.7.1 时代的 vendored provider）搬入 2026.8.2 新包：旧 kimi 插件旧 marker 补丁继续生效 ✓；依赖 SDK 向后兼容（实测旧 subpath 均存在）✓
- 换装后重打补丁：新装 2026.8.2 内核树走第 4 节 marker（9/10 命中）✓
- 配置迁移框架 since 门控支持 2026.8 规则；新规则必须降级安全（只删废弃节点）
- 已知债（OPTIMIZATION-PROGRESS.md:366）：上游布局迁移需人工核对——本次已核对，dist/extensions 与 skills 路径未变

## 8.1 适配实施与 e2e 实测结果（2026-09-03，本机真实换装）

**实施中发现并修复的三个新问题：**

1. **preinstall Node 版本硬校验（构建侧）**：openclaw ≥2026.8 带 `scripts/preinstall-package-manager-warning.mjs`，npm install 时用裸 `node` 校验 `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`。宿主机 Node 24.14.0 被拒装。修复：package-resources.js 的 installDependencies 改用 Step 1 下载的捆绑运行时（node + npm-cli.js）执行安装，并将 runtime 目录前置 PATH（lifecycle 脚本里的裸 `node` 按 PATH 解析）。
2. **preinstall Node 版本硬校验（运行时热更新侧，更严重）**：kernel-update.mjs 的 npmRun 原先继承宿主 env——用户机器无系统 Node 或版本不符时，**内核热更新到 2026.8.2 必然失败**。修复：npmRun env 将 `resources/runtime` 前置 PATH。e2e 实测修复前必现失败、修复后通过。
3. **asar 内 kimi 补丁校验路径**：verifyAsarContents 与打包期告警只查 `kimi/dist/index.js`，2026.8.x 包形态下补丁在 `provider-policy-api.js` → 误报缺补丁。修复：两处校验均改为双候选文件。

**e2e 实测（.cache/kernel-e2e，真实 asar 换装）全通过：**

| 路径 | 结果 |
|---|---|
| --check（current 2026.8.2 / latest 2026.8.2） | ✓ |
| 降级 2026.8.2 → 2026.7.1-2 | ✓ 换装+冒烟通过；asar 内内核版本正确；9 个注入插件 + 2 个内置 skill 全部 carryOver；asar-bypass 补丁 6 chunk（含 2026.7 世代补丁 10 peerLinkRepair，已验证打上）；kimi 插件 carryOver 后新形态补丁标记保留 |
| 升级 2026.7.1-2 → 2026.8.2 | ✓（修复 2 后）；asar-bypass 5 chunk（2026.8.2 无补丁 10 目标，符合预期）；kimi provider-policy-api.js 补丁在 |
| --rollback 2026.8.2 → 2026.7.1-2 | ✓ 备份还原后补丁/注入物随 asar 完整还原；两份备份均在 |
| 新装打包（package-resources win32-x64） | ✓ gateway.asar 312MB，verifyOutput 全 OK，5 个边界校验模块补丁，kimi 补丁标记 asar 内校验通过 |

## 9. UI 功能 parity 参考（阶段 2 可选吸收）

上游 Control UI 新增：Home dock（Cmd/Ctrl+Shift+H）、后台会话（Cmd/Ctrl+Enter）、会话分组菜单/transcript 复制 Markdown/分屏打开、四款主题、跨会话转发气泡。CryoClaw 自有 UI 重写时可评估吸收会话组织类改进；主题体系由我们自己的浅色现代风取代。
