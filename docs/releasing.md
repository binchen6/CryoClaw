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

   3.6. **CDP 冒烟 + UI 截图 QA（发版固定四步）**：
   ```bash
   node scripts/layout-cdp-smoke.js --port 9227       # 主视图 rail 巡览 × 宽度/主题/DPI/动效/语言
   node scripts/settings-cdp-smoke.js --port 9229     # 设置页全 tab 巡览 + MCP 表单展开（跨组件重叠/异常/裸 key）
   node scripts/interaction-cdp-smoke.js --port 9231  # 交互级：逐视图/tab 实际操作 + 危险确认框 Escape 取消（异常追踪）
   node scripts/ui-screenshot-qa.js --port 9230       # 全页面系统化截图 + report.json（out/ui-qa/）供视觉审查
   ```
   四个脚本共用 `scripts/lib/cdp-harness.js`（启动/连接/就绪轮询/清理），首屏等待为轮询而非固定 sleep。
   四者任一非零退出码都不得发版（重叠/异常/裸 key/body 横向滚动条是硬门槛）；
   ui-screenshot-qa 另在截图目录写 `report.json`（重叠/文本裁切/低对比度明细），截图与报告按需人工/AI 复核。
   交互冒烟与前三者的区别：前三者是"看"（几何/截图/文本），它是"动"——真实点击控件并验证键盘语义
   （R70 新增，正是它发现了「重置配置并重启」确认框无法用 Escape 取消）。
   注意：跑冒烟前确保没有其他 CryoClaw 实例在运行（单实例锁会让被测进程直接退出，
   表现为"90s 内未发现 file:// 页面 target"）。
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

6. **草稿验收再转正**：草稿期间先完成本地安装版四路 UI、实际消息与远端资产校验，再执行上面的 ③。公开客户端不会发现未发布草稿，不能把「上一版自动更新发现草稿」当作验收条件。转正后复核 latest 指向、公开清单和更新发现行为。

7. **真实消息闭环**：`node scripts/live-chat-cdp-smoke.js --exe <installed-CryoClaw.exe> --live`。显式 `--live` 才调用已配置提供商；脚本创建独立且清晰命名的 QA 会话，要求真实回复进入历史，不改用户原有会话。四路 UI 脚本现在对应用/网关未就绪直接失败，不能把骨架屏当成验收通过。

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
