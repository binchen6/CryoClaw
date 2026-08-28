# Common Gotchas

Things that are easy to get wrong or forget when working on CryoClaw.

1. **`npm install file:` creates symlinks, not copies.** Always use `--install-links` for physical copy. This is critical for electron-builder packaging.

2. **Cross-platform build needs re-packaging.** After switching target platform, `npm run package:resources` must run again because the Node.js binary and native modules differ per platform.

3. **All Kimi sub-platforms use unified config.** All three (moonshot-cn, moonshot-ai, kimi-code) write `apiKey` + `baseUrl` + `api` + `models` to `models.providers`. No special-casing.

4. **Health check timeout is 90 seconds.** This is intentionally long for Windows. Don't reduce it without testing on slow machines.

5. **Tray app behavior.** Closing the window hides it; the app stays in the tray. `Cmd+Q` (or Quit from tray menu) actually quits. macOS Dock icon hides automatically when no windows are visible.

6. **macOS signing.** By default uses ad-hoc identity (`-`). Set `CRYOCLAW_MAC_SIGN_AND_NOTARIZE=true` + `CSC_NAME`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` in `.env` for real signing.

7. **Version is auto-derived from git tag.** Format: `YYYY.MMDD.N` (e.g. `v2026.318.0`). `package.json` stays `0.0.0-dev`; CI extracts version from tag via `npm version`. Never manually edit `package.json` version.

8. **No local upstream directory needed.** openclaw is installed from npm directly during `package:resources`. The `upstream/` directory is no longer required.

9. **Blockmap generation is disabled.** Both DMG and NSIS have blockmap/differential disabled to avoid unnecessary `.blockmap` files.

10. **macOS auto-update requires ZIP.** electron-updater needs the ZIP artifact, not DMG. Both are built: DMG for manual distribution, ZIP for auto-update.

11. **`OPENCLAW_NO_RESPAWN=1` is required.** All child processes (gateway, doctor, CLI) must set this env var to prevent subprocess self-respawning, which causes console window flickering on Windows.

12. **Gateway entry fallback.** `resolveGatewayEntry()` tries `openclaw.mjs` first (new packages), then falls back to `gateway-entry.mjs` (legacy). Both paths must be considered during packaging verification.

13. **CLI wrapper uses RC block markers.** Install/uninstall is idempotent via `# >>> cryoclaw-cli >>>` / `# <<< cryoclaw-cli <<<` markers in shell profiles. Always check for marker presence before modifying.

14. **Kimi Search API key is a sidecar file**, not in `openclaw.json`. Stored at `~/.openclaw/credentials/kimi-search-api-key`. Auto-reuses kimi-code provider key if no dedicated key exists.

15. **AGENTS.md is a symlink to CLAUDE.md.** Don't create separate content — they share the same file.

16. **Gateway port is configurable.** Resolution order: env `OPENCLAW_GATEWAY_PORT` > config `gateway.port` in `openclaw.json` > default `18789`. Don't hardcode port numbers — use `resolveGatewayPort()` from `constants.ts`.

17. **Gateway npm update check is disabled.** CryoClaw writes `update.checkOnStart = false` to the gateway config at startup. The gateway cannot self-update inside a packaged Electron app.

18. **`cryoclaw.config.json` is the ownership marker.** CryoClaw uses this file to detect config ownership at startup. Detection flow: `cryoclaw.config.json` exists → normal startup; `.device-id` exists → legacy migration; `openclaw.json` exists without marker → external OpenClaw takeover; nothing → fresh Setup. Do not delete this file manually.

19. **Skill store config is standalone.** Registry URL stored in `~/.openclaw/skill-store.json`, not in gateway config. Skills installed to `~/.openclaw/workspace/skills/`, not `~/.openclaw/skills/`.

20. **CLI wrapper invokes bundled Node.js.** The wrapper scripts use the real bundled Node.js binary from the app package, not the system node.

21. **Token injection uses URL fragment.** Gateway auth token is passed via `#token=...` in the loaded URL, not query parameter or localStorage.

22. **Build config replaces analytics config.** `build-config.json` (renamed from `analytics-config.json`) is injected at build time and read by `build-config.ts`. Contains PostHog key, clawhub registry, and other build constants.

23. **Gateway ASAR mode requires patched boundary check.** `package-resources.js` patches openclaw's `openBoundaryFileSync()` to skip validation for `.asar` paths. Without this patch, the plugin security check rejects ASAR virtual paths and gateway fails to start.

24. **ASAR mode changes path resolution.** `resolveGatewayRoot()` auto-detects `gateway.asar` vs `gateway/` directory. ASAR mode: `resolveGatewayCwd()` returns `~/.openclaw/` (OS can't chdir into ASAR). Gateway subprocess uses Electron binary + `ELECTRON_RUN_AS_NODE` to read ASAR transparently. CLI interactive mode on Windows requires a CONSOLE subsystem binary (Electron is GUI subsystem, cannot hold interactive TTY).

25. **Windows uses assisted installer.** NSIS `oneClick: false` mode enables installation directory selection and custom uninstall options. `installer.nsh` provides CLI cleanup and user data removal checkboxes. `createDesktopShortcut: "always"` ensures shortcut is recreated on update.

26. **Windows CLI wrapper lives in `%LOCALAPPDATA%\CryoClaw\bin\`.** Not in `~/.openclaw/bin/` like POSIX. Legacy path migration handles old users who had wrappers in `~/.openclaw/bin/`.

27. **Client-side polling uses shared ticker.** All periodic polling in Chat UI must go through the 60s `client-ticker.ts` mechanism (`registerTickHandler`/`unregisterTickHandler`). Do not create standalone `setInterval` calls. See [client-ticker.md](client-ticker.md).

28. **Tooltips must use the global fixed-position approach.** Never use CSS `::after` pseudo-elements for tooltips — they get clipped by any parent with `overflow: auto/hidden`. Use the shared `.fixed-tooltip` DOM element with JS event delegation (`mouseover` + `getBoundingClientRect()`). Chat UI initializes it in `main.ts`, Settings in `settings.js`. Just add `data-tooltip="text"` to any element. Use `data-tooltip-pos="bottom"` for downward tooltips.

29. **Design tokens are the single source of truth.** All CSS variables (colors, radii, shadows, fonts, transitions) live in `shared/design-tokens.css`. Chat UI, Settings, and Setup all `@import` this file. Never hardcode color values or `border-radius` in component styles — use tokens. Never use `transition: all` — specify exact properties.

30. **Scrollbars must use native overlay behavior — declare nothing.** Any scrollbar styling forces Chromium out of overlay mode on macOS, making scrollbars permanently visible. This includes both `::-webkit-scrollbar{,-thumb,-track}` AND the standard `scrollbar-width` / `scrollbar-color` properties when set to concrete values. The only way to preserve the native "show on scroll, auto-hide when idle" behavior is to not declare any scrollbar rules at all. `scrollbar-width: none` is still allowed for places that intentionally hide the scrollbar (like the nav bar).

31. **Weixin QR success must atomically enable the channel.** Writing `~/.openclaw/openclaw-weixin/accounts/*.json` alone is not enough. If `plugins.entries.openclaw-weixin.enabled` and `channels.openclaw-weixin.enabled` are not written in the same success path, Settings can show "已连接" while the Gateway never starts the Weixin channel, so no replies are sent.

32. **Windows `shouldPreferNativeJiti` is hard-wired to false — dingtalk cannot live on the external-plugin path.** In openclaw 2026.4.5 `dist/sdk-alias-*.js`, `shouldPreferNativeJiti()` unconditionally returns `false` on `process.platform === "win32"`. This forces every `.mjs` plugin loaded through the external plugin scanner (`~/.openclaw/extensions/<id>/`) to go through jiti transform mode instead of Node's native ESM cache. The plugin loader re-evaluates the bundle on each top-level invocation (~115 times/hour observed on an idle dingtalk), which re-runs `register()`. Idempotent `register` is fine (`openclaw-weixin`, `wecom-openclaw-plugin`), but **dingtalk-connector's register creates a new `DWSClient` stream per call, all sharing the same `clientId`** — the DingTalk server kicks/ghosts the flood of duplicate handlers and phone messages silently stop being delivered. For this reason dingtalk **must** stay in the bundled path (`gateway.asar/node_modules/openclaw/dist/extensions/dingtalk-connector`) via the createRequire-based channel-entry shim: the shim itself can be jiti-re-eval'd N times, but `createRequire` routes the inner `legacyModule` load through Node's process-wide require cache, so DWS is created exactly once. macOS `shouldPreferNativeJiti` returns true for `.mjs`, so the external path works there — but it is not a safe basis for channel plugins with non-idempotent register. See PR #79 `d58c0be` and `scripts/package-resources.js#writeChannelEntryShim`.

33. **Built-in channel plugin entries can be shadowed by `plugins.allow`.** For bundled channels such as Feishu, a non-empty `plugins.allow` can disable a legacy `plugins.entries.<channel>.enabled=true` entry when the channel id is absent from the allowlist, even if `channels.<channel>.enabled=true` is present. Extension mirror writes `plugins.allow` for external mirrored plugins at startup, so avoid leaving redundant built-in channel entries that can mask the channel-enabled activation path.

34. **Setup's `#view=setup` fragment must survive reloads until setup completes.** The renderer intentionally does not persist `cryoclawView: "setup"` to localStorage, so the URL fragment is the only reload-safe signal while `WindowManager.setupPending` is true. Do not strip `view=setup` during initial URL cleanup; remove it only when the app leaves Setup.

35. **DingTalk saves must strip deprecated channel fields on both enable and disable.** `dingtalk-connector` rejects `gatewayToken` and `sessionTimeout` under the openclaw 2026.4.x schema. Disabling DingTalk is often the recovery path for a bad config, so the disabled save path must also remove those fields instead of preserving the old channel object verbatim.

36. **POSIX CLI PATH injection must cover login and interactive shells.** macOS Terminal usually reads `~/.zprofile`, but VS Code Terminal and some iTerm/zsh setups only read `~/.zshrc`; bash has the same split between `~/.bash_profile` and `~/.bashrc`. Install the `cryoclaw` PATH block into all four files (`.zprofile`, `.zshrc`, `.bash_profile`, `.bashrc`) so users can run `openclaw` after opening a new terminal.

37. **Chrome browser mode must not point at the old `chrome-relay` profile on openclaw 2026.4.x.** The Chrome extension relay driver/profile existed in older openclaw builds, but 2026.4.x uses the built-in `user` existing-session profile for host Chrome. If Settings writes `browser.defaultProfile: "chrome-relay"` without a valid profile, the browser control root returns `BrowserProfileNotFoundError`; if users copy the token into the old extension, they may also hit the wrong derived browser-control port. Migrate missing or legacy `driver: "extension"` profiles to `user`.

38. **Session delete goes synchronous with per-row spinner — no tombstone queue.** Click → `sessions.reset` → `sessions.delete` → `loadSessions` refresh, all awaited inline. Each row tracks its own in-flight state via a module-level `deletingSessionKeys: Set<string>` so the delete button swaps to a spinning `icons.loader` and disables clicks while work is in flight; other rows stay interactive. With `session-memory` hook enabled the reset step triggers an LLM summary (400-600KB jsonl can take 10-90s on CN providers), so the spinner window is long and the same WebSocket serializes concurrent deletes — acceptable, but don't try to "optimize" with optimistic filter or persisted hidden/pending queues: both pathways were tried and re-introduce resurrection bugs when the UI hides a key the gateway still owns.

39. **macOS dev Node child processes must use the Electron Helper binary.** Under `npm run dev`, `process.execPath` is `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`, whose app bundle has no `LSUIElement`. Spawning it with `ELECTRON_RUN_AS_NODE=1` works functionally, but LaunchServices still treats it as a Dock app, so the gateway / short CLI child processes can show extra bouncing "Electron" console-style icons. `resolveNodeBin()` must prefer `Electron Helper.app/Contents/MacOS/Electron Helper` in dev and `CryoClaw Helper.app` when packaged; both Helper apps have `LSUIElement=true` and keep background Node-style children out of the Dock.

40. **Volcano DataFinder requires the server-side endpoint `gator.volces.com/v2/event/json`.** The client-side SDK endpoint `mcs.ctobsnssdk.com` does not accept server-side payloads and rejects with `HTTP 400 -9 "app_id uint32 -1"` (the `-1` is a sentinel baked into the error template, not the value actually sent). `VOLCANO_ENDPOINT` must be set in `.env` together with `VOLCANO_APP_ID` and `VOLCANO_APP_KEY` — missing any one causes `package:resources` to leave the volcano section of `build-config.json` empty and the analytics sink to be disabled at runtime.

41. **Weixin enable/reconnect must reconcile external plugins before writing config.** Since 2026.424.0, `openclaw-weixin` is loaded from `~/.openclaw/extensions/openclaw-weixin` via the external plugin scanner, not from the gateway bundled extension tree. Any Settings path that writes `plugins.entries.openclaw-weixin.enabled=true` or `channels.openclaw-weixin.enabled=true` must first run `reconcileExtensionsOnAppLaunch()` and verify the plugin directory exists; otherwise a missing user extension makes openclaw reject the channel during config validation and the gateway cannot restart.

42. **Provider saves must pass the verified `supportImage` result.** Setup and Settings must verify the provider first, copy `verifyProvider(...).supportsImage` into the save payload, and let `resolveModelInput()` write `["text", "image"]` only when that explicit value is `true`. Missing or `false` `supportImage` must stay text-only, even for preset model names that are usually multimodal.

43. **Image probing is best-effort after provider verification.** The provider availability check is authoritative for whether a key can be saved. The follow-up image probe only decides the model `input` field: successful image requests set `supportsImage: true`, while rejected probe requests return `supportsImage: false` without failing the provider save.

44. **Image probe payload must be a stock-zlib-encoded PNG, not a hand-crafted "shortest possible" 1×1.** The earlier `TINY_PNG_B64` was the well-known minimum-deflate 1×1 PNG with IDAT bytes `08 d7 63 60 00 02 00 05 00 01 36`. `api.msh.team`'s image decoder rejects exactly this zlib bitstream with `HTTP 400 "failed to decode image: invalid or unsupported image format"` — even though the same gateway accepts any other 1×1, 2×2, or 16×16 PNG produced by stock `zlib.compress(...)`. That message contains both `image` and `unsupported`, so `isExplicitImageUnsupported()` in `src/provider-image-probe.ts` classifies it as `{kind: "unsupported"}` and `supportsImage: false` gets written to `openclaw.json` even though the model itself supports vision. **The size is not the root cause** — a 1×1 grayscale PNG (67 bytes, 92-char base64) produced by Node `zlib.compress` works on every model tested (msh.team kimi-k2.6 / kimi-latest / kimi-k2.5 / vision-pro family / text-only family). If you change `TINY_PNG_B64`, re-encode via `zlib.compress` from a fresh raw scanline buffer; never paste another hand-rolled minimum-deflate PNG.
45. **Sensitive IPC handlers must validate the sender origin.** `src/ipc-sender-guard.ts` exposes `assertTrustedIpcSender(event, channel)`: it verifies the sender's main frame URL is the Chat UI entry (`file://…index.html` + `?query`/`#hash` only). Apply it to every handler that controls the gateway, kernel, app lifecycle, or touches the filesystem (`kernel:*`, `gateway:*`, `app:quit`, `app:open-*`, `dialog:select-files`, `workspace:*`, `settings:*openclaw-state`). `ipcMain.handle` should throw on false; `ipcMain.on` should return. The pure URL predicate `isTrustedChatUiUrl()` is unit-tested — keep the prefix/suffix rule strict (reject `index.html2`, `/../`, `/evil`).

46. **Chat UI vendor chunking + file:// modulepreload.** `chat-ui/ui/vite.config.ts` splits lit/marked/dompurify/@noble into `vendor-*` chunks via `manualChunks`. The built `index.html` then contains `<link rel="modulepreload" href="./assets/vendor-*.js">`. These stay same-origin under `file://`, so the CSP `script-src 'self'` still passes — but never re-add `crossorigin` to those tags (the `stripCrossorigin` plugin exists because Chromium treats `crossorigin` on module scripts as a CORS fetch that silently fails for `file://`). `chunkSizeWarningLimit: 700` is intentional: the app chunk is ~500 kB of business code after vendors are extracted; the limit exists only to surface abnormal growth, not to force risky dynamic-import refactors.

47. **`console-message` legacy `level` semantics are 0-3 (verbose/info/warning/error).** The deprecated numeric overload still fires in Electron 40 and is what `src/main.ts` `attachRendererDebugHandlers` consumes. `formatConsoleLevel` must map `["VERBOSE","INFO","WARNING","ERROR"]` — an earlier draft labeled them LOG/WARNING/ERROR/DEBUG/INFO and was wrong. `level >= 2` → `log.error`, `level === 0` (console.debug) is dropped in production unless `__KEEP_CRYOCLAW_DEBUG__`/`OPENCLAW_DEBUG` is set.

48. **`openclaw-version-utils.js` must stay free of `shell:true`.** `readRemoteLatestVersion()` spawns npm through explicit `cmd.exe /c npm …` (Windows) / `npm …` (POSIX) with `shell:false`, plus a package-name whitelist regex — same pattern as `kernel-update.mjs`'s `npmRun`. Re-introducing `shell:true` resurrects DEP0190 and reopens cmd metacharacter injection. Version strings passed to `--tag` in `kernel-update.mjs` are additionally validated by `KERNEL_VERSION_RE`.

49. **Chat UI 新增视图只需接线 3 处（阶段 16 起，views/registry.ts 是唯一事实来源）。**
    历史「4+1 处」（setCryoClawView union / active 标志 / fullpage 条件 / 渲染三元链 /
    storage union）已收敛：① `views/registry.ts` 的 `CRYOCLAW_VIEW_IDS` 与
    `CRYOCLAW_VIEW_META`（fullpage/titlebarBack 标志）各加一条；② `storage.ts` 无需改
    （`UiSettings["cryoclawView"]` 类型从 registry 导入，自动生效；若允许 URL `?view=` 注入，
    把新 id 加进 `INJECTABLE_VIEWS`）；③ `app-render.ts` 的 `renderActiveView()` switch
    加渲染分支。视图切换统一走 `app-view-switch.ts` 的 `setCryoClawView()`，enter/leave
    副作用用其钩子表注册（参考 app-feedback.ts），不要在切换函数里堆 if。

50. **（已失效，保留存档）会话管理独立全页视图已在阶段 15 删除**，其能力并入侧边栏会话列表
    （搜索/置顶/归档/重命名/删除）。本条历史的 `loadSessionsManage()`/`sessionsManageResult`
    已不存在。归档视图注意点仍有效：`sessions.list` 的 `archived: true` 是「仅返回已归档」，
    切换归档视图必须重拉列表，返回正常视图也要重拉。

51. **Tasks 状态过滤必须放在客户端。** `tasks.list` 带 `status` 时只返回该状态，
    会污染侧边栏「进行中」徽标计数（`isActiveTask` 基于全量列表）。始终全量拉取
    （limit 200），视图内再按 `statusFilter` 过滤。`task` 网关事件 payload 固定为
    `{action:"upserted", task}` / `{action:"deleted", taskId}` / `{action:"restored"}`；
    未知 action 应全量重拉兜底（内核若扩展 action 值，本地解析天然向前兼容）。

52. **Cron agentTurn payload 的 `model` 是可选的，空值 = 默认模型。** 内核
    `cronAgentTurnPayloadSchema` 中 `model: Type.Optional(...)`，提交空串会被校验拒绝，
    所以 `buildCronPayload` 只在 `form.payloadModel` 非空时才写入 `payload.model`；
    编辑回填用 `job.payload.model`（string 才写回，避免把 unknown 直接塞进表单）。
53. **NSIS 静默安装残留进程会让后续实例退出码 2。** 用 `& setup.exe //S` 或
    `Start-Process -ArgumentList '/S'` 安装 CryoClaw 时，如果之前的安装进程没有完全退出
    （`CryoClaw-Setup-*` 仍挂在进程表），新实例会立即以退出码 2 结束且不产生任何日志——
    看起来像安装失败，实际只是"another instance is running"。重试前必须先
    `Get-Process -Name "CryoClaw-Setup*" | Stop-Process -Force`，再 `/S` 安装。
    安装成功判据：`%LOCALAPPDATA%\Programs\CryoClaw\resources\app.asar` 的时间戳
    更新为安装包构建时间（与 `out\win32-x64\win-unpacked\resources\app.asar` 一致）。
54. **scripts 测试加载器必须对 CRLF 行尾健壮。** `scripts/package-resources.test.js` 的
    `loadPackageResourcesSandbox()` 用正则移除源码里的 `main().catch(...)` 再进 vm 沙箱；
    该正则按 LF 编写，Windows checkout 下文件是 CRLF 时失配，`main()` 会在沙箱里真实执行
    （npm install + 下载 + 资源打包），导致单文件测试 227 秒、依赖网络、偶发失败。
    读源码前先 `.replace(/\r\n/g, "\n")` 归一化即可（修复后 0.27s 全离线）。
    新增任何"加载源码进沙箱"的测试都要做同样的行尾归一化。
55. **IPC sender guard 必须容忍 chat-ui 的 history 路由改写。** `assertTrustedIpcSender`
    检查 senderFrame.url，而 renderer 加载后 history API 会把 pathname 从
    `/dist/index.html` 改写成 `/dist/<route>`（如 `/chat?session=...`）。若 guard 只认
    `index.html` 文件前缀，所有敏感 IPC（kernel:* / gateway:* / workspace:* 等）会被
    拒——tab-about 拿到 null 后**静默不渲染内核卡片**，表现为"功能消失"。
    guard 前缀必须用 `chat-ui/dist/` 目录 + 已知路由集合（见 `ipc-sender-guard.ts`
    `KNOWN_CHAT_UI_ENTRIES`）。新增路由视图时必须同步加入该集合。
56. **chat-ui 视图引用 lit 符号但漏导入 → 运行时崩溃且构建不拦截。** vite/esbuild 不做类型
    检查，chat-ui `typecheck` 用 `--noCheck`：在视图模板里引用 `nothing`/`html`/`t`/`icons`
    而 import 缺失时，构建照常通过，运行时才抛 `ReferenceError: xxx is not defined`，
    表现是"点了没反应"（渲染异常）。2026.731.4 的"设置按钮无反应"即此因
    （settings-view 用了 nothing 只导入了 html）。修复后请全量扫描：
    grep 使用 `nothing` 但 lit import 不含它的文件；发版前 CDP 冒烟点击关键入口
    （设置/会话管理/任务）并捕获 Runtime.exceptionThrown。
57. **CDP 冒烟后 taskkill 可能污染 gateway 启动环境。** 反复用 `taskkill /F /IM CryoClaw.exe`
    终止验证实例后，gateway 端口（18789）会出现 TIME_WAIT、子进程残留，导致下一次启动
    gateway 子进程数毫秒内 exit code=1（gateway.log 只见 spawn + child exited，无 stderr）。
    发版后实测前：先 `Get-Process -Name "CryoClaw*" | Stop-Process -Force`，等 5-10 秒，
    再启动；gateway.log 出现 "Gateway ready" 才算干净。
58. **compose 加号按钮/附件按钮在 gateway 未连接时 disabled 是设计行为。** chat.ts 的
    `?disabled=${!props.connected}` 与历史回形针按钮一致：CDP 冒烟必须等按钮 enabled
    （gateway HTTP 200 后 connected=true）再点击，否则 click 事件不触发、菜单不出现，
    容易被误判为 bug。
59. **chat-ui i18n 插入新 key 时锚点定位错误会造成 zh 区被英文覆盖。** 阶段 11/12 多次用
    「找锚点 key 第一次/第二次出现」的方式插入 zh/en keys；若锚点本身是新增 key（zh 区原本
    没有），第一次 indexOf 会定位到 en 区，导致 **zh 区混入英文值、en 区缺失**。JS 对象重复
    key 后定义覆盖 → t() 在中文界面返回英文。修复后请用脚本校验：zh 区（dict.zh 与 dict.en
    之间）不得有重复 key、所有 zh key 必须在 en 区有对应。新增 i18n key 时优先手写插入或
    用「既有 key」作锚点。
60. **主进程强制 locale 必须用 app.commandLine.appendSwitch("lang", "zh-CN") 且在 ready 前。**
    Electron 的 navigator.language 跟随 Chromium locale，非中文系统（或 Electron 未继承
    Windows 语言）下返回 en-US。CryoClaw 面向中文用户，模块顶层 appendSwitch 后渲染层
    i18n 默认中文；CDP 实证 navigator.language=zh-CN。
61. **electron-builder 的 win/mac 平台级 `files` 会【覆盖】全局 `files`，不是合并。**
    本项目 yml 历史上在 `win.files: ["!assets/**/*.icns"]` / `mac.files: ["!assets/**/*.ico"]`
    只用了否定模式：平台级 files 一旦存在即替换全局白名单，仅剩否定模式的 matcher 会被
    electron-builder 自动补 `**/*`（fileMatcher.js: containsOnlyIgnore → prepend "**/*"），
    导致 **整个项目根打进 app.asar**（asar 571M，含 .env.build 构建配置、.cache 调试缓存、
    resources/targets 与 afterPack 注入重复的 384M；安装包从 134MB 涨到 275MB）。
    修复：平台图标否定合并进全局 files（运行时不读 .ico/.icns，icon 由 electron-builder
    构建期从仓库读取），删除 win/mac 平台级 files 键。教训：**永远不要使用平台级 files**；
    打包后用「读 asar 头部 JSON 的 files 键」验证顶层条目（脚本见阶段 22 记录）。
62. **`win.files` 覆盖生效后，白名单外的敏感物会随安装包分发。** .env.build（含
    CRYOCLAW_KIMI_CLAW_REFRESH 等）曾长期被打进所有历史安装包；排查打包内容时优先怀疑
    平台级配置覆盖，其次才是 files 语义本身。
63. **`server.listen(port, host, cb)` 的 cb 不能用于端口占用重试。** cb 是注册一次性
    "listening" 监听，EADDRINUSE 失败尝试的 cb 不会被摘除；重试成功后旧 cb 会以旧端口
    先触发（Windows 实测：同一 server 上 error 与两个 listening cb 都触发）。端口递增
    重试必须用持久的 error/listening 监听 + `server.address().port` 核对实际绑定端口
    （见 `src/gateway-control-server.ts` 的 `listenWithPortRetry`）。
64. **CDP 冒烟脚本的 `child.kill()` 杀不干净 Electron 进程树，残留实例会吞掉单实例锁。**
    脚本 spawn `CryoClaw.exe --remote-debugging-port=N`，超时后 `child.kill()` 只终止直接
    子进程，helper/renderer 进程可能残留并继续持有 `requestSingleInstanceLock()`。此时再启动
    的新实例因拿不到锁而**立即退出、调试端口根本不开**，表现为「120s 轮询不到任何 CDP 页 /
    `/json/list` 连接被拒」。冒烟前后必须 `taskkill /F /IM CryoClaw.exe /T` 并用
    `tasklist | grep -ci cryoclaw` 确认为 0 再启动；若需复用已运行实例做检查，直接连它的
    调试端口（见 `.cache/cdp-8111-check.js`），别再 spawn 第二个。
65. **GitHub release 大二进制直连会被 `read ECONNRESET`（SHA256SUMS 能下、30MB+ 被重置）。**
    officecli pin 升到 1.0.143 时 `downloadOfficeCli` 失败。绕过：用镜像前缀
    `https://gh-proxy.com/<原 GitHub URL>` curl 下来，落到脚本约定的缓存路径
    `.cache/officecli/<version>/<asset>`，再跑打包即自动命中缓存（SHA256 校验兜底，勿跳过）。
    备选镜像 ghproxy.net 亦可；镜像源不稳定，失败换下一个。
66. **NSIS 同版本覆盖安装 `/S` 可能在文件拷贝完成后卡收尾。** 判据：
    `%LOCALAPPDATA%\Programs\CryoClaw\resources\app.asar`（及 `resources/resources/gateway.asar`）
    时间戳已是本次构建 → 安装实际完成，直接 `taskkill /F /PID <安装器>` 即可，不必等它自己退。
    另注意：安装器收尾可能自启应用，占住单实例锁——后续 CDP 冒烟前先 taskkill 清零（见 #64）。
67. **electron-updater 的 `quitAndInstall()` spawn 的 NSIS 安装器在真实 app 上下文中会静默死亡。**
    现象：检查/下载/校验全通，日志到 `Executing: pending\CryoClaw-Setup-...exe --updated,/S,--force-run`
    为止，安装器进程建立 %TEMP%\ns*.tmp（stub 自解压成功）后 ~37s 无任何文件操作即退出，
    app.asar 全程不变。而同一 exe 同参数在 bash 直跑、node `spawn(...,{detached:true,
    stdio:"ignore"}).unref()`（父立即退/优雅退/被 taskkill 强杀）下全部换装成功。
    已排除：installer.nsh 的 `taskkill /T` 树杀、quit-cleanup 删临时目录、父退出方式、cwd、
    MOTW、签名。定案：不再用 `autoUpdater.quitAndInstall()`，在 `src/app-updater.ts` 自实现
    换装 spawn（`update-downloaded` 事件存 `info.path` 文件名，拼
    `%LOCALAPPDATA%\cryoclaw-updater\pending\<name>`，detached+stdio:ignore+unref 后
    `app.quit()`；文件缺失时回退 quitAndInstall）。真实链路实测 821.0→821.2 换装+自启成功。
68. **NSIS 安装器内的 `taskkill /IM "<App>.exe" /T /F` 会杀掉安装器自己的进程树。**
    NSIS 安装器运行时进程名与主程序不同，但 `/T` 树杀沿父子链向上匹配——若安装器是被
    主程序 spawn 的（更新流程），主程序在被杀前其子进程（安装器）一并被终止，表现为
    「换装静默失败」。教训：安装器脚本里杀主程序永远**不要带 /T**（customInit 已改）。
    虽非 #67 的根因（去掉 /T 后 updater spawn 仍失败），但该改动本身必须保留。
69. **每次重装旧版后 `resources/app-update.yml` 被安装器重置回 github provider。**
    本地更新链路测试（generic 127.0.0.1 源）在每次 `Setup.exe /S` 重装后必须重新覆盖
    app-update.yml，否则检查更新会打到真实 GitHub（无 latest.yml 时 404）。这是测试
    流程最容易忘的一步，表现为「下载/检查毫无反应或报 404」。

70. **dev 冒烟环境三坑（R21 实录）。**
    ① `scripts/package-resources.js` 的 `packGatewayAsar()` 打完 gateway.asar 后**会删除
    `gateway/` 散文件目录**——任何一次 `dist:win`/`package:resources` 后 dev 模式
    （`resolveGatewayRoot` 非 packaged 强制走散文件）起不来，报「FATAL: gateway 入口不存在」。
    恢复：`node node_modules/@electron/asar/bin/asar.mjs extract gateway.asar gateway/`
    再 `cp -r gateway.asar.unpacked/* gateway/`。
    ② 后台任务 TaskStop 只杀 `npx` 壳进程，electron 子进程残留 → 下一次启动撞单实例锁
    秒退（无任何日志输出）。重启 dev 前必须 `taskkill /F /IM electron.exe /T` 清场。
    ③ dev 冷启动后**首个 config.patch 落盘可超过 60 秒**（gateway 启动本身 ~46s，渠道
    初始化期间 patch 排队），CDP 冒烟对 `~/.openclaw/openclaw.json` 的文件断言轮询窗口
    要给 ≥120s，否则误 FAIL（功能实际正常）。
    另 CDP 驱动教训：设置页可能已处于打开态（无侧边栏按钮可点，直接切 nav）；
    设置导航有「模型与能力」与「模型」两项，正则要精确匹配全等文本；
    `<oc-toggle-switch>` 的 click 处理器在**内层 `.oc-toggle` div** 上
    （createRenderRoot=this 无 shadow DOM），对宿主元素 click() 不触发，须
    `el.querySelector(".oc-toggle").click()`。

71. **CSS 注释里绝不能出现 `*/` 序列（通配写法与斜杠相邻即中招，如 `...oc-items-* / oc-...` 中 `*` 紧跟 `/` 拼出 `*/`）。**
    esbuild/vite 均不报错，但注释提前闭合会把后续规则吞进前一个选择器块——
    P5 实录：utilities.css 头注释写 `oc-items-*` → 打包产物里 base.css /
    primitives.css 整段嵌进 `.oc-flex-col{}`，body `margin:0` 丢失、
    全局偏移 8px + 横向溢出 23px。教训：改样式 hub/原子类文件后，用
    「产物 head 断言」（如打包产物以 `:root{--radius-2` 开头）或 CDP 冒烟复核，
    别只信构建退出码。

72. **CDP 冒烟重打 app.asar 必须基于原包 extract（保留 node_modules）。**
    正确路线：`asar extract` 原 app.asar（含 node_modules）→ 覆盖新
    dist/chat-ui/dist/shared → 重打包替换。直接拿源码 dist 目录打新 asar 会丢
    node_modules，主进程无声卡死（无日志、窗口不出），排查极费时。
