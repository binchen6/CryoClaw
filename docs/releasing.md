# CryoClaw 发布流程（GitHub Releases + electron-updater）

本文档描述 CryoClaw App 级自动更新的发布管线。内核（openclaw runtime）升级走独立的 registry 链路，不在本文范围。

## 总览

- 更新源：GitHub Releases（`electron-builder.yml` 的 `publish: provider: github, owner: binchen6, repo: CryoClaw`）。
- 客户端：`src/app-updater.ts`（electron-updater）。public 仓库，检查更新**不需要 token**。
- 发布凭证：`GH_TOKEN`（仅需发布时），见 `.env.build.example`；只放本地 `.env.build` 或 shell export，**绝不入库**。

## Windows 发布步骤

1. **版本 bump**：改 `package.json` 的 `version`（**必须同步**在 `release-notes.json` 顶部补对应版本条目，zh/en 双份——应用内「更新日志」与 Release 说明都读它）。
2. **本地打包**：

   ```bash
   node scripts/dist-win.js            # x64
   node scripts/dist-win.js --arch arm64
   ```

   打包结束后脚本会自动断言：
   - PE Certificate Table 是否非空（已签名）。未签名打印 ⚠ 警告但**不 fail**（无 CSC_LINK 证书时用户首装会看到 SmartScreen 警告）。
   - 同批产物是否含 `.exe.blockmap` 与 `latest.yml`（差分更新必需）。

3. **核对产物清单**（`out/win32-<arch>/`），以下三个文件**必须同批、进同一个 Release**：
   - `CryoClaw-Setup-<version>-<arch>.exe` — NSIS 安装包
   - `CryoClaw-Setup-<version>-<arch>.exe.blockmap` — 差分下载元数据
   - `latest.yml` — 更新清单（版本号 + 文件 sha512）
3.5. **静默安装 E2E（必须走脚本，勿在 shell 直接传 `/S`）**：Git Bash 的 MSYS 路径转换会吃掉 `/S`，
   NSIS 收不到静默开关就弹出交互向导（gotcha #91——此前每次「静默验证」实际都是人工点完的）。用：

   ```bash
   node scripts/silent-install.js out/win32-x64/CryoClaw-Setup-<version>-x64.exe <version>
   # 或 npm run install:silent -- <installer> <version>
   ```

   脚本自动杀残留进程 → Node spawn 原样传参真静默安装（等待退出）→ 读安装位 app.asar 校验版本一致。

   3.6. **CDP 冒烟 + UI 截图 QA（发版固定四步）**：
   ```bash
   node scripts/layout-cdp-smoke.js --port 9227       # 主视图 rail 巡览 × 宽度/主题/DPI/动效/语言
   node scripts/settings-cdp-smoke.js --port 9229     # 设置页全 tab 巡览 + MCP 表单展开（跨组件重叠/异常/裸 key）
   node scripts/interaction-cdp-smoke.js --port 9231  # 交互级：逐视图/tab 实际操作 + 危险确认框 Escape 取消（异常追踪）
   node scripts/ui-screenshot-qa.js --port 9230       # 全页面系统化截图（out/ui-qa/）供视觉审查
   ```
   四者任一非零退出码都不得发版（重叠/异常/裸 key 是硬门槛）；截图目录按需人工/AI 复核。
   交互冒烟与前三者的区别：前三者是"看"（几何/截图/文本），它是"动"——真实点击控件并验证键盘语义
   （R70 新增，正是它发现了「重置配置并重启」确认框无法用 Escape 取消）。
5. **发布（gh CLI 草稿流，现行标准做法）**：

   ```bash
   # ① 建草稿 Release（同批上传 exe + blockmap + latest.yml）
   gh release create v<version> out/win32-x64/CryoClaw-Setup-*.exe out/win32-x64/*.blockmap out/win32-x64/latest.yml --draft
   # ② 核对资产：三个文件齐全、版本号与 package.json 一致
   gh release view v<version> --json isDraft,assets
   # ③ 草稿实测通过后转正并设为 latest
   gh release edit v<version> --draft=false --latest
   # ④ API 复核最终状态（isDraft=false、资产完整）
   gh api repos/binchen6/CryoClaw/releases/tags/v<version> --jq '{draft:.draft, assets:[.assets[].name]}'
   ```

   备选（一步直发，跳过草稿实测，不推荐）：`GH_TOKEN=ghp_xxx npx electron-builder --win --x64 --publish always` 会把 exe / blockmap / latest.yml 一并上传到 GitHub Release（默认草稿）。

6. **草稿实测再转正**（重要）：Release 保持 draft 期间，本地装**上一个正式版本**，启动后等 ~15s 自动检查（或设置 → 关于 → 检查更新），确认能发现新版本并弹窗（v2026.906.0 起为弹窗决策模式，点「更新」才下载）；验证通过后再执行上面的 ③ 转正。

## 注意事项

- **GitHub Releases 没有服务端回滚**：正式 Release 一旦发布，客户端即可能拉到。发错版本的补救方式是删除该 Release（或改回 draft），再发一个更高版本号的新 Release。`latest.yml` 里的 `version` 必须与 `package.json` 一致，发布前建议人工比对一眼。
- 多架构（x64 + arm64）发布时，两个架构的 `latest.yml` 需要合并为一份再上传：`scripts/merge-release-yml.js` 的多架构合并逻辑在 GitHub 流程下**仍保留使用**（Windows 合并 win32-x64 + win32-arm64 → 单个 latest.yml）。
- oneclaw.cn CDN 上传链路（`scripts/volcengine-cdn-refresh.js` 等）对 App 更新已**归档不再使用**（文件保留，勿删）；客户端更新全部走 GitHub Releases。

## macOS 简述

- target 为 `dmg`（手动分发）+ `zip`（自动更新；electron-updater 在 macOS 上要求 zip）。
- `electron-builder.yml` 已配置 `hardenedRuntime: true` + `notarize: true`，签名身份由 `CSC_NAME` 指定（见 `.env`），公证凭据走 `APPLE_*` 环境变量。
- 产物：`CryoClaw-<version>-<arch>-mac.zip` + `CryoClaw-<version>-<arch>.dmg`（含 blockmap）+ `latest-mac.yml`，同样要求同批进同一个 Release。
