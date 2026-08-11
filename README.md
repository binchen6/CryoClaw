<p align="center">
  <img src="assets/icon.png" width="120" alt="CryoClaw Logo" />
</p>

<h1 align="center">🧊 CryoClaw</h1>

<p align="center">
  <strong>CryoClaw — 基于 openclaw 内核的高效、易用、纯净 harness</strong><br/>
  An efficient, easy-to-use, pure harness built on the <a href="https://github.com/openclaw/openclaw">OpenClaw</a> kernel.<br/>
  一分钟装好，即刻开聊。零配置、零依赖的 OpenClaw 桌面客户端。
</p>

<p align="center">
  <a href="https://github.com/binchen6/CryoClaw/releases/latest"><img src="https://img.shields.io/github/v/release/binchen6/CryoClaw?style=flat-square&color=0EA5E9" alt="Latest Release" /></a>
  <a href="https://github.com/binchen6/CryoClaw/blob/main/LICENSE"><img src="https://img.shields.io/github/license/binchen6/CryoClaw?style=flat-square" alt="License" /></a>
</p>

---

## 🇨🇳 中文

### ✨ 项目简介

CryoClaw 是在 **[OneClaw](https://github.com/oneclaw/oneclaw)**（AGPL-3.0）基础上**二改重构**的 openclaw 桌面 harness：保留了「一分钟装好、开箱即用」的核心体验，对视觉设计、设置架构、执行效率、存储体积与模型管理做了系统性重设计与优化。

这个项目同时是一次 **vibe coding** 实践——全部迭代由人类掌舵需求与验收，通过与多个 AI 编码助手的**多轮协同对话**完成：

| 角色 | 模型 / 工具 | 分工 |
|---|---|---|
| 主力 | **Kimi K3**（Kimi Code） | 架构重设计、核心功能实现 |
| 协同 | **DeepSeek v4 Flash**（Codex） | 代码审查、打包与效率优化 |
| 协同 | **Qwen3.8 Max**（Qoder） | 调试取证、测试与文档 |

> 内核 [OpenClaw](https://github.com/openclaw/openclaw) 保持零改动，CryoClaw 只改桌面壳与打包链路。

### 🆚 与 OneClaw 相比

| 维度 | OneClaw | CryoClaw |
|---|---|---|
| 视觉设计 | 原版主题 | 全新冰蓝 TraeWork 设计体系（浅色/暗色双主题、design token + cc-* 原语组件） |
| 更新策略 | 应用自动更新（CDN） | 移除自动更新，纯净 harness；仅保留内核升级/回退（差分 ASAR 换装） |
| 设置架构 | 主进程自研读写 IPC | 全面切换内核 `config.get`/`config.patch`（乐观锁 + RFC7396 diff），退役 15+ 自研 IPC |
| 流式渲染 | 逐帧全量 markdown | 逐帧纯文本流式 + 终态一次性排版（消除 O(n²) 卡顿），折叠区懒渲染 |
| 存储体积 | — | gateway.asar 裁剪 279.6 → 237.6MB（非目标平台原生包/冗余类型声明/sourcemap） |
| 模型管理 | 基础列表 | provider 分组 + 拖拽排序 + 自定义分组 + fallback 链 + 搜索 + 密钥有效性探测 + 四处选择器联动 |
| CLI | `openclaw` PATH 注入 | 额外提供 gateway CLI 托管（127.0.0.1 控制面，`openclaw gateway restart/status` 不再报错） |
| 启动速度 | — | 窗口先行 + 内核并行启动，约 0.6s 看到界面 |
| 测试 | — | 435 个用例全量回归（vitest + node:test + typecheck），0 fail 为硬指标 |

### 🚀 快速上手

**方式一：安装包（推荐）**

前往 [Releases 页面](https://github.com/binchen6/CryoClaw/releases/latest) 下载 Windows x64 安装包：

```
1️⃣  双击 CryoClaw-Setup-<版本>-x64.exe 安装
2️⃣  选择服务商，输入 API Key
3️⃣  开始对话！
```

不需要装 Node.js，不需要 `npm`，不需要配置任何环境变量。

**方式二：源码构建**

```bash
# 需要 Node.js >= 22.12
git clone https://github.com/binchen6/CryoClaw.git
cd CryoClaw
npm install
npm run dev          # 开发运行（首次会自动下载并打包 openclaw 内核）
npm test             # 全量测试
npm run dist:win     # 打包 Windows x64 安装包 → out/win32-x64/
```

### 🤖 支持的 AI 提供商

Anthropic (Claude) / OpenAI (GPT / Codex) / Google (Gemini) / Moonshot（Kimi）/ DeepSeek / GLM / Qwen / 自定义 OpenAI / Anthropic 兼容接口。支持主模型 + fallback 备用链，自动降级时界面有提示。

### 💬 多渠道集成

飞书 / 企业微信 / 钉钉 / QQ Bot / 微信 —— 设置 → 渠道 中扫码绑定，让 AI 在你的团队 IM 里干活。

### 🏗️ 技术细节

```
CryoClaw (Electron 40 + TypeScript 5.9)
  ├── 主进程壳        src/          IPC 白名单 + sender guard；gateway 子进程托管
  ├── 内核            openclaw 2026.7.1-2（版本 pin，gateway.asar，零改动）
  ├── 聊天界面        chat-ui/      Lit 3 + Vite SPA，file:// 本地加载
  ├── 内核升级器      scripts/updater/  差分 ASAR 换装/回滚 + 冒烟自检
  └── 打包链路        scripts/package-resources.js → electron-builder
```

- **通信**：chat-ui 经 WebSocket RPC 与 gateway 内核通信（内核注册 237 个 RPC 方法）；渲染层 CSP 只允许连接 127.0.0.1。
- **渲染**：markdown 引擎（marked + DOMPurify）支持 GFM 表格/任务列表，样式化的标题与斑马纹表格；LRU 缓存 + 流式旁路防污染，解析异常自动退化为纯文本。
- **安全**：全部 IPC 通道过 sender guard；API Key 只存本机（`~/.openclaw/openclaw.json`）；日志统一脱敏；open-external 仅放行 http(s)。
- **内核升级**：设置页「内核升级」卡片或 `openclaw update` CLI，差分换装、双备份、健康检查失败自动回滚。
- **执行权限**：请求批准 / 智能审批 / 完全同意三态 + Docker 沙箱前置守卫；支持 `update_plan` 计划悬浮面板、目标模式、消息队列、`/` 命令补全。
- **样式体系**：`shared/design-tokens.css`（TraeWork token + 冰蓝 brand-500 `#0EA5E9`）+ `styles/primitives.css` 契约组件，禁止硬编码颜色。
- **测试**：vitest（主进程单测）+ node:test（编译产物/脚本）+ chat-ui typecheck 与单测 + scripts 用例，`npm test` 一键全量（基线 435 pass / 0 fail）。

详细架构与历史优化记录见 `docs/architecture.md` 与 `docs/OPTIMIZATION-PROGRESS.md`。

### ❓ 常见问题

**Q: 我完全不会编程，可以用吗？**
A: 当然可以！CryoClaw 就是为非技术用户设计的。

**Q: 可以从 OneClaw 迁移过来吗？**
A: 可以。两者共享 `~/.openclaw` 内核数据目录，会话、渠道、凭据无缝继承；OneClaw 的应用配置会在首启时自动迁移。

**Q: Setup 之后可以换 Provider 吗？**
A: 可以。在托盘菜单点「设置」即可修改。

**Q: 为什么移除了自动更新？**
A: CryoClaw 定位是纯净 harness：应用本体保持简单，能力演进交给内核升级器（可升级、可回滚、有更新日志）。

---

## 🇬🇧 English (Summary)

**CryoClaw** is a fork-and-rebuild of [OneClaw](https://github.com/oneclaw/oneclaw) (AGPL-3.0): an efficient, easy-to-use, pure harness around the [OpenClaw](https://github.com/openclaw/openclaw) kernel. The whole project was iterated via **vibe coding** — multi-round collaborative sessions with Kimi K3 (Kimi Code, lead), DeepSeek v4 Flash (Codex) and Qwen3.8 Max (Qoder), with humans steering requirements and acceptance.

Highlights over OneClaw: ice-blue TraeWork design system (light/dark), auto-updater removed in favor of a kernel-only upgrader (diff ASAR swap with rollback), settings fully migrated to kernel `config.get`/`config.patch`, streaming rendered as per-frame plain text (no more O(n²) jank), hardened markdown engine (GFM tables & task lists, parse-failure fallback), gateway.asar trimmed from 279.6 to 237.6MB, model management with custom groups / drag-reorder / fallback chains, managed gateway CLI, ~0.6s startup, and a 435-test regression baseline (0 fail).

Download from [Releases](https://github.com/binchen6/CryoClaw/releases/latest) (Windows x64 installer), or build from source with Node.js ≥ 22.12 (`npm install && npm run dev`).

---

### 🤝 参与贡献 / Contributing

想参与开发？请先阅读 **[CONTRIBUTING.md](CONTRIBUTING.md)**。
Want to contribute? Please read **[CONTRIBUTING.md](CONTRIBUTING.md)** first.

### 🙏 致谢 / Acknowledgements

- [OpenClaw](https://github.com/openclaw/openclaw) — 本项目封装的 agent 内核。
- [OneClaw](https://github.com/oneclaw/oneclaw) — 本项目的上游代码库；CryoClaw 在其基础上更名、重设计并重构（修改说明见上文「与 OneClaw 相比」）。

### 📄 License

GNU Affero General Public License v3.0 (`AGPL-3.0-only`)，与上游 OneClaw 一致。

Commercial use is allowed, but if you modify and distribute this software, or provide a modified version over a network, you must provide the corresponding source code under AGPL v3.
