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

   Windows 打包会优先复用项目已安装的 Electron 分发；版本文件必须与解析后的 npm 包版本一致，PE 架构也必须匹配 x64/arm64。缺失或不匹配时回到正常下载流程，不混用不同版本或架构的二进制。

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

   脚本自动杀残留进程 → 在普通用户 Temp 新建副本并流式复制 → Node spawn 原样传参真静默安装（等待退出）→ 读安装位 app.asar 校验版本一致 → 清理自己的临时副本。每 30 秒报告进度，整体超时 15 分钟。必须从获准的普通用户进程执行，不能通过修改安装目录 ACL 绕过权限错误。

   Codex Windows 沙箱生成的输出目录可能继承 `Low Mandatory Level`。即使获准在沙箱外调用该 exe，Windows 也可能按文件标签启动低完整性进程，导致它无法覆盖普通安装目录里的 `uninstallerIcon.ico` 等文件；`/S` 甚至可能返回 0 而版本未变。先用 `icacls <installer.exe>` 核对标签；经授权在普通用户 Temp 目录创建副本，再对副本运行上述安装脚本，并校验源与副本哈希一致。不要修改安装目录权限或忽略写入错误。

   3.6. **统一 UI 冒烟（一次启动）**：
   ```bash
   node scripts/release-ui-smoke.js --exe <installed-CryoClaw.exe>
   ```

   修改首装路径时另运行 `node scripts/setup-ui-smoke.js`，以隔离 profile 和合成 IPC 验证完整向导，不在真实账户上重新走安装。

   正式发版只运行此入口，不再依次运行旧四套脚本。每次操作至少等待600ms，字体、DOM提交和连续三次布局稳定检查有明确截止；等待有限动画结束和页面数据就绪；45秒内仍在加载直接失败。一次启动共享网关就绪、页面遍历和批量扫描，按宽屏浅色/窄屏暗色边界覆盖全部主视图，逐个检查所有设置 tab，再覆盖英文、125%/150% DPI 与减少动态效果。MCP 展开、危险确认 Escape 取消、任务 loading 归属、编辑往返和保存中禁用为硬断言。

   默认只保存 5 张基准、关键交互和失败截图；每个场景的重叠、裸键、溢出、对比度、布局诊断与耗时写入 `out/ui-release/<timestamp>/report.json`。renderer 异常、裸键、跨组件重叠、页面横向溢出或缺少关键控件均失败，不能静默跳过。文字裁切和对比度保持诊断项，需复核关键截图。

   壳层/主题重写加 `--full` 恢复全部宽度×主题组合；需要全场景截图加 `--screenshots-all`。旧入口仅用于定向诊断。脚本异常时也保存报告，并在 finally 清理自己的应用进程；冒烟期间不能同时运行其他应用实例。

5. **发布（gh CLI 草稿流，现行标准做法）**：

   ```bash
   # ① 建草稿 Release（同批上传 exe + blockmap + latest.yml）
   gh release create v<version> out/win32-x64/CryoClaw-Setup-*.exe out/win32-x64/*.blockmap out/win32-x64/latest.yml --draft
   # ② 核对资产：三个文件齐全、版本号与 package.json 一致
   gh release view v<version> --json isDraft,assets
   # ③ 草稿实测通过后转正并设为 latest
   gh release edit v<version> --draft=false --latest
   # ④ 资产断言（硬门槛，非零退出即不得宣发）：三件套齐全 + latest.yml 版本一致
   npm run release:assert
   # ⑤ API 复核最终状态（isDraft=false、资产完整）
   gh api repos/binchen6/CryoClaw/releases/tags/v<version> --jq '{draft:.draft, assets:[.assets[].name]}'
   ```

   `scripts/release-assert.js` 也可在草稿期用 `--allow-draft` 预检（上传完资产后立即跑），
   加 `--deep` 会流式下载 exe 重算 SHA-512，受 30 秒空闲超时、10 分钟整体截止、容量与重定向限制保护，不把整包读入内存。
   也可用 `node scripts/release-assert.js --allow-draft --local-dir out/win32-x64`：逐一对比本地三件套与 GitHub 服务端生成的 SHA-256、大小和上传状态，同时确认安装器符合清单中的 SHA-512。该方式适合本地产物已完成安装验收、但大文件 CDN 缓慢的环境。两种校验方式都不得忽略不匹配。

   备选（一步直发，跳过草稿实测，不推荐）：`GH_TOKEN=ghp_xxx npx electron-builder --win --x64 --publish always` 会把 exe / blockmap / latest.yml 一并上传到 GitHub Release（默认草稿）。

6. **草稿验收再转正**：草稿期间先完成本地安装版统一 UI、实际消息与远端资产校验，再执行上面的 ③。公开客户端不会发现未发布草稿，不能把「上一版自动更新发现草稿」当作验收条件。转正后复核 latest 指向、公开清单和更新发现行为。

7. **真实消息闭环**：`node scripts/live-chat-cdp-smoke.js --exe <installed-CryoClaw.exe> --live`。显式 `--live` 才调用已配置提供商；脚本创建独立且清晰命名的 QA 会话，要求真实回复进入历史，不改用户原有会话。统一 UI 门禁现在对应用/网关未就绪直接失败，不能把骨架屏当成验收通过。

过期输出清理使用 [维护流程](MAINTENANCE.md)，与全量重建的 `npm run clean` 分开。

## 注意事项

- Windows `beforePack` 会通过 `scripts/patch-nsis-uninstall.js` 校验并调整 electron-builder 的旧卸载重试流程，使卸载失败直接进入 `customUnInstallCheck` 恢复逻辑。上游模板结构不符时构建失败，不能跳过补丁继续发布；真实进程占用检测仍保留。
- OpenAI 独立代理引导的两个 `.cjs` 模块由 `afterPack` 注入包外资源，网关经 `--require` 加载。打包与启动验收必须检查这两个文件，避免只验证开发态成功。

- **GitHub Releases 没有服务端回滚**：正式 Release 一旦发布，客户端即可能拉到。发错版本的补救方式是删除该 Release（或改回 draft），再发一个更高版本号的新 Release。`latest.yml` 里的 `version` 必须与 `package.json` 一致，发布前建议人工比对一眼。
- 多架构（x64 + arm64）发布时，两个架构的 `latest.yml` 需要合并为一份再上传：`scripts/merge-release-yml.js` 的多架构合并逻辑在 GitHub 流程下**仍保留使用**（Windows 合并 win32-x64 + win32-arm64 → 单个 latest.yml）。任一架构缺 `latest*.yml` 会**硬失败**（残缺清单会让该架构用户永远收不到更新）；确认要发布不完整产物需显式加 `--allow-partial`。
- oneclaw.cn CDN 上传链路（`scripts/volcengine-cdn-refresh.js` 等）对 App 更新已**归档不再使用**（文件保留，勿删）；客户端更新全部走 GitHub Releases。

## macOS 简述

- target 为 `dmg`（手动分发）+ `zip`（自动更新；electron-updater 在 macOS 上要求 zip）。
- `electron-builder.yml` 已配置 `hardenedRuntime: true` + `notarize: true`，签名身份由 `CSC_NAME` 指定（见 `.env`），公证凭据走 `APPLE_*` 环境变量。
- 产物：`CryoClaw-<version>-<arch>-mac.zip` + `CryoClaw-<version>-<arch>.dmg`（含 blockmap）+ `latest-mac.yml`，同样要求同批进同一个 Release。

发布前可用 `node scripts/update-discovery-smoke.js --from <older-version> --expect <current-public-version>` 验证真实 SDK 的公开发现逻辑，关闭自动下载；发布后用上一正式版与新版本号重复检查。该 Node 工具读取 `https_proxy`，与 Electron 客户端自动使用系统代理的行为不同。Node 24 的独立 release-assert 如需代理，可使用已有代理环境并加 `--use-env-proxy`；网络失败必须保留为失败，不能跳过校验。

## 更新与本地扩展（2026.1021.0）

稳定版客户端直接读取官方 Release 的 latest.yml，减少 GitHub API 往返与限流。受管部署可在客户端运行环境设置 CRYOCLAW_APP_UPDATE_URL 为可信 HTTPS 目录；目录须保留清单、安装器和 blockmap 三件套，下载仍由 electron-updater 核验 SHA-512。此环境变量不是构建期注入配置。

技能与插件页支持选择本地目录导入。技能目录必须含 SKILL.md，拒绝符号链接、超过 2000 个条目或 32 MiB 的内容，同名目录不覆盖；插件目录须有 package.json、openclaw.plugin.json 和目录内可读入口。插件安装沿用内核的安装审计。本地项只读本地详情，不参与更新检查。
