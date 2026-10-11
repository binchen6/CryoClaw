# Rust 重写评估报告（分模块）与归档模块 Rust sidecar 落地记录

日期：2026-10-08。范围：`src/` ~90 个模块 + `scripts/`。结论先行：**唯一够格的 Rust 重写对象是 `.openclaw` 归档导入/导出/校验（openclaw-state-archive*）**，已以「Rust sidecar 双 backend」形态落地（见下文运维章节）；其余模块评估不修及，理由见各表。

## 1. 评估方法

- 逐模块归类：CPU 密集（压缩/解析/转码/加密）× Rust 高收益；IO/等待型（HTTP、子进程、IPC、定时器、文件元数据）× Rust 无收益（瓶颈不在语言运行时）。
- 对每个候选读代码核实瓶颈证据（文件 + 行号），而非凭模块名猜测。
- 兼容性约束：所有用户可见错误文案有中文快照依赖倾向（如 `openclaw-state-archive.test.ts` 中断言「已中止导入」「已从应急归档自动还原」）；chat-ui 渲染层有 DOMPurify XSS 语义。重写任何一侧都要求逐条复刻语义，成本计入「风险与兼容性」。

## 2. 逐模块评估表

### 2.1 IO/等待型模块（Rust 无收益，不修及）

| 模块 | 当前瓶颈证据（文件 + 行号） | Rust 收益 | 集成成本 | 推荐形态 | 风险与兼容性 |
| --- | --- | --- | --- | --- | --- |
| kimi-auth-proxy（HTTP 代理） | `src/kimi-auth-proxy.ts`：纯 HTTP 转发 + token 刷新等待 | 低 | 高（需 napi/sidecar 桥接） | 保持 JS | 协议等待 dominate，语言无关 |
| gateway-process（子进程管理） | `src/gateway-process.ts:348-382`：spawn/健康检查轮询（`HEALTH_POLL_INTERVAL_MS`，`src/constants.ts:39`） | 低 | 高 | 保持 JS | 瓶颈是子进程启动与端口探测 |
| analytics（埋点） | `src/analytics.ts`：HTTP 批量上报 + 重试退避 | 低 | 中 | 保持 JS | 网络等待 dominate |
| provider-live（provider 状态探测） | `src/provider-config.ts:707-734`：8MB 上限的 HTTP 拉取 | 低 | 中 | 保持 JS | 同上 |
| 配置读写 / atomic-write / readUserConfig 缓存 | `src/atomic-write.ts`、配置缓存层：已是 O(小文件) + 内存缓存 | 低 | 中 | 保持 JS | 无热点 |
| logger | `src/logger.ts`：已异步化（追加写 + 轮转） | 低 | 低 | 保持 JS | 已非瓶颈 |
| git-parse | `src/git-parse.ts`：解析受 `git exec` + IPC 约束（`src/git-run.ts`） | 低 | 中 | 保持 JS | 解析本身非瓶颈 |
| diagnostics-export | `src/diagnostics-export.ts:13-15`：~10MB 冷路径，已设上限并异步 | 低 | 中 | 保持 JS | 冷路径，不值得 |

### 2.2 渲染层（chat-ui markdown）

| 模块 | 当前瓶颈证据 | Rust 收益 | 集成成本 | 推荐形态 | 风险与兼容性 |
| --- | --- | --- | --- | --- | --- |
| chat-ui markdown 渲染 | 已被架构优化消化（稳定段切分 + LRU + memo，chat-ui/src 内实现） | 低 | 极高 | 保持 TS | DOMPurify 的 XSS 白名单语义无法用 Rust 等价复刻；wasm 化还要跨边界搬运 DOM 语义，收益为负 |

### 2.3 唯一候选：`.openclaw` 归档导入/导出/校验（已落地 Rust sidecar）

| 项 | 内容 |
| --- | --- |
| 模块 | `src/openclaw-state-archive.ts`、`src/openclaw-state-archive-zip.ts`、`src/openclaw-state-archive-paths.ts`、`src/openclaw-state-import-lifecycle.ts` |
| 瓶颈证据 | ① 导出：fflate deflate level 6 纯 JS 压缩（`openclaw-state-archive.ts:348`），数百 MB 目录；② CRC32 为逐字节 JS 循环（`openclaw-state-archive-zip.ts:539-545`）；③ 校验与导入双遍解压（`openclaw-state-archive.ts:97-114,127`），失败还原再加一遍（`:136`）；④ 导入期间 gateway 停摆（`openclaw-state-import-lifecycle.ts:31-33`，stop → import → start），导出/解压耗时直接 = 停机时长 |
| Rust 收益 | 高（预估 deflate/CRC 5-20x，整链路受 IO 与快照拷贝摊薄后仍为数量级改善） |
| 集成成本 | 中（sidecar 协议 + 双 backend 回退 + 打包链注入） |
| 推荐形态 | **独立 Rust sidecar 二进制**（argv 子命令 + stdin/stdout JSON Lines），见 §3 |
| 风险与兼容性 | 错误文案需逐条对齐（现有测试有中文错误串断言）；双 backend 同测 + 缺失回退 JS 兜底，行为契约不变 |

## 3. Sidecar 形态选择理由

- **napi-rs（四目标 prebuild + asar unpack）**：复杂度高——需要为 win32-x64/win32-arm64/darwin-arm64/darwin-x64 维护 prebuild 矩阵、Electron ABI 对齐、asar unpack 规则；与本仓库「独立二进制 + resources 注入」的 OfficeCLI 先例不一致。放弃。
- **wasm（WASM-JS）**：数百 MB 数据须经 JS 边界中转（TypedArray 拷贝/分块），直接吃掉压缩收益；且同步 wasm 会阻塞主进程事件循环。放弃。
- **sidecar 独立二进制**：对齐 OfficeCLI（`scripts/package-resources.js` Step 7）与 WebBridge daemon 的既有 spawn 子进程模式；无 ABI 耦合（纯 CLI 协议）；打包链复用下载/缓存/sha256 链；缺失时回退纯 JS fflate 实现，灰度风险为零。**选定**。

## 4. Rust crate：`native/cryoclaw-archive/`

### 4.1 结构

> **为何手写容器格式而非直接用 `zip` crate**：`zip` crate 当前版本能力足够
> （streaming write + seek 回补 CRC/长度、central directory 生成、deflate/store），
> 但其字节布局不受我们控制（ZIP64 判定、extra field、data descriptor 策略随版本
> 变化），而本项目的 JS 读取器只接受一个严格子集（单盘/非 ZIP64/无加密/local 与
> central 逐字节一致）。手写容器（~300 行）+ `flate2` 换来对产物字节的完全控制，
> 并消除一个重型依赖的供应链与升级审查面；CRC32 用 `crc32fast`（SIMD）。

```
native/cryoclaw-archive/
├── Cargo.toml          # edition 2021，无 unsafe；依赖：flate2（deflate，miniz_oxide 纯 Rust 后端）、crc32fast、serde/serde_json（JSON Lines 协议）
├── README.md           # 构建命令与协议摘要
└── src/
    ├── main.rs         # 子命令分发 + JSON Lines 读写
    ├── protocol.rs     # stdin/stdout JSONL 协议类型与行读写
    ├── errors.rs       # 结构化错误（code + message），message 与 JS 实现逐条对齐
    ├── zip_writer.rs   # 流式 zip 创建：local header 占位 → deflate 流 → 回 seek 补写 CRC/长度
    ├── zip_reader.rs   # central directory 解析 + local header 一致性校验（与 JS 读取器同规则）
    └── extract.rs      # 单遍流式解压：CRC32 校验 + 写盘 + 元数据恢复
```

### 4.2 协议（stdin/stdout JSON Lines）

- argv 子命令：`cryoclaw-archive --version`、`create`、`manifest`、`extract`。`--version` 输出 `cryoclaw-archive <semver>`（JS 侧握手用）。
- 输入：单行 JSON command（`create`/`extract` 的条目清单可能很大，单行大 JSON 避免双向管道死锁；JS 侧异步写 stdin + 并发读 stdout）。
- 输出（stdout，每行一个 JSON）：
  - 进度：`{"type":"progress","done":N,"total":M,"entry":"<name>"}`（≥100ms 节流）。
  - 结果：`{"type":"result","ok":true,...}` 或 `{"type":"result","ok":false,"error":{"code":"...","message":"..."}}`；进程 exit 0/1 与之一致。
- stderr 仅人类可读诊断；协议只走 stdout。

| 子命令 | 职责 | 权威校验归属 |
| --- | --- | --- |
| `create` | 按 JS 收集的条目清单（顺序、relPath、kind、mode、mtime、store/deflate）流式写 zip；CRC/长度先行占位、写完后回 seek 补写（无 data descriptor） | JS（条目收集/路径校验不变） |
| `manifest` | 只解析 central directory + local header 一致性（不解压），输出条目清单 | Rust 结构校验；JS 拿到清单后跑路径注册表/条目白名单/大小上限 |
| `extract` | 单遍流式解压：结构校验 + 每条目 CRC32/长度校验 + 写盘 + chmod/utimes + 目录元数据（最深优先）；含 capture 条目时以 base64 内联返回 | JS（解压前的清单白名单）；Rust 另做目标路径前缀约束（防御纵深，防 zip slip） |

### 4.3 错误文案对齐

Rust 侧 `errors.rs` 对共有校验失败使用与 JS 完全相同的中文 message（如 `不是有效的 ZIP 数据包`、`ZIP 分卷数据包不受支持`、`ZIP64 数据包不受支持`、`ZIP 加密数据包不受支持`、`ZIP 压缩方式不受支持`、`ZIP CRC 校验失败: <name>`、`ZIP entry 长度校验失败: <name>`、`ZIP entry 过大: <name>`、`重复 entry: <name>` 等）。JS 集成层对 sidecar 的 `ok:false` 一律回退纯 JS backend 重跑，由 JS 产生权威错误文案（sidecar 只在构建/自检日志里可见），彻底规避双实现文案漂移。

## 5. JS 集成落点

- `src/archive-backend.ts`（新增）：sidecar 探测（`--version` 握手 + 缓存，负结果也缓存）、二进制路径解析（dev 解析顺序：`CRYOCLAW_ARCHIVE_TOOL_BIN` 覆盖 → `native/cryoclaw-archive/target/release/` → resources 注入路径 → 无）、JSONL 会话封装（spawn/进度/结果/回退）。
- `src/openclaw-state-archive-zip.ts`：`readArchive` 改为 backend 分发——探测到 sidecar 走 Rust（manifest → JS 白名单/注册表校验 → extract），任何失败回退原 JS 实现；原实现保留为 `readArchiveWithJs`（契约测试 `vi.mock("./openclaw-state-archive-zip")` 的拦截点不变）。
- `src/openclaw-state-archive.ts`：`exportOpenclawStateToArchive` 在 `writeZip` 处做 backend 分发（Rust create 直写目标路径）；validate/import 流程不动（它们经 `readArchive` 自动分流）。`openclaw-state-import-lifecycle.ts` 零改动（注入 deps 的契约不变）。
- 测试：`src/openclaw-state-archive.test.ts` 等既有测试原样作为契约测试；新增 `src/archive-backend.test.ts`（sidecar 缺失时 = 现状 JS 回退的覆盖）与 `src/openclaw-state-archive-dual-backend.test.ts`（双 backend 同测，Rust 不可用时 skip 并注释）。

## 6. 打包链

- `package.json`：`cryoclaw.archiveTool` 版本钉定（与 `cryoclaw.officecli` 同法）。
- `scripts/package-resources.js`：新增 Step 7.2 `prepareArchiveTool()`——复用下载/缓存/sha256 链：优先本地产物 `native/cryoclaw-archive/target/release/`（`--version` 与 pin 一致才采纳）→ `.cache/archive-tool/<version>/` 缓存 → GitHub Releases 预留下载（仓内尚无发布物，下载失败/校验失败 **warn 且不 fail 构建**）→ 输出 `<targetBase>/archive-tool/` + stamp。`verifyOutput` 不强制要求该资源（可选，缺失 = 运行时 JS 回退）。
- `electron-builder.yml`：mac/win `extraResources` 注入 `resources/targets/<platform>-${arch}/archive-tool` → `resources/archive-tool`。
- 运行时解析：`src/archive-backend.ts` 按 §5 顺序探测；`resolveResourcesPath()` 逻辑等价实现（dev = `resources/targets/<platform>-<arch>/archive-tool`，packaged = `process.resourcesPath/resources/archive-tool`），不依赖 electron import，保持归档模块可在无 electron 环境下测试。

## 7. 运维：如何构建 / 发新版 sidecar / 如何回退

### 7.1 构建（开发机）

```bash
cd native/cryoclaw-archive
cargo build --release        # 产物 target/release/cryoclaw-archive[.exe]
cargo test                   # 单元测试（CRC、DOS 时间、容器格式往返）
```

- 工具链：stable Rust（无需 rust-toolchain 钉定），edition 2021，无 unsafe。依赖：`flate2`（miniz_oxide 纯 Rust 后端，raw deflate）、`crc32fast`、`serde`/`serde_json`。
- **链接器注意**：本机无 MSVC Build Tools，使用 `stable-x86_64-pc-windows-gnu` 工具链 + MinGW GCC（`cargo +stable-x86_64-pc-windows-gnu build --release`，需 mingw `bin` 在 PATH）；装了 VS Build Tools 的机器用默认 msvc 工具链即可。若 `link.exe` 报 "extra operand"，是 Git Bash 的 GNU coreutils `link` 遮蔽了 MSVC linker——把 VS 的 `Hostx64\x64` 目录前置到 PATH。
- dev 模式下 `src/archive-backend.ts` 会直接探测上述产物路径，**无需任何配置即可生效**；`CRYOCLAW_ARCHIVE_TOOL_BIN=/path/to/bin` 可显式覆盖（调试/测试用）。

### 7.2 发新版 sidecar

1. 改 `native/cryoclaw-archive/Cargo.toml` 的 `version`。
2. 同步改 `package.json` 的 `cryoclaw.archiveTool`（构建期以该 pin 为准做 `--version` 比对与缓存目录名）。
3. 四目标交叉编译（GitHub Actions 矩阵：win/darwin × x64/arm64）后上传 Release 资产 `cryoclaw-archive-<platform>-<arch>[.exe]` + `SHA256SUMS`（下载 URL 已在 `package-resources.js` 预留）。
4. 打包链自动：缓存未命中 → 下载 → sha256 校验 → 注入 `resources/archive-tool/`。

> 当前状态：仓内尚无 GitHub Release 产物，打包链走「本地产物优先」；本地产物缺失/版本不符时 warn 并继续（运行时回退 JS）。CI 交叉编译发布链是**遗留事项**（见 §9）。

### 7.3 如何回退

- 运行时回退（自动）：sidecar 二进制缺失/握手失败/运行失败/校验拒绝 → `src/archive-backend.ts` 落回纯 JS fflate 实现，用户可见行为与未引入 Rust 前完全一致（错误文案由 JS 权威产生）。
- 运行时回退（手动开关）：环境变量 `CRYOCLAW_ARCHIVE_TOOL=off`（或 `0`/`false`）显式禁用 sidecar（探测负缓存，零文件系统探测）——排障与 A/B 对照用；`CRYOCLAW_ARCHIVE_TOOL_BIN=<path>` 显式指定二进制（调试/测试用）。
- 构建期回退（自动）：`prepareArchiveTool()` 任何一步失败仅 warn，不打断 `package:resources`。
- 彻底移除：删 `package.json` 的 `cryoclaw.archiveTool` pin + 清空 `native/cryoclaw-archive`（探测自然落空，全链路回 JS）。

## 8. 验证记录（2026-10-10 实测）

- **Rust 侧**：`cargo test` 7/7 通过（base64/EOCD 扫描/DOS 纪元/create→manifest→extract 往返/Store 字节腐坏 → `ZIP CRC 校验失败` 精确文案）；`cargo build --release` 零警告产出 `cryoclaw-archive.exe`（≈820KB）。
- **双 backend 同测**（`src/openclaw-state-archive-dual-backend.test.ts`，真实 spawn sidecar）：JS/Rust 产物互相校验通过、清单级（entry 名 + CRC32 + 未压缩长度）严格相等、互相解压后树内容字节一致、CRC 损坏归档两侧一致拒绝。
- **真实目录往返**（~53MB 混合内容，export→validate→import 全链路）：

  | 阶段 | JS (fflate) | Rust sidecar | 加速 |
  | --- | --- | --- | --- |
  | export（含快照拷贝） | 623ms | 148ms | 4.2x |
  | validate（全量 CRC） | 682ms | 57ms | 12x |
  | import（validate+应急备份+解压） | 1403ms | 165ms | 8.5x |

- **JS 全量基线**：`tsc --noEmit`（主/测试配置）✅；vitest 266/266；node:test 310/310（含 dual-backend）；scripts 109/109；chat-ui 903/903；`npm run dupcheck` 1.29%（阈值 5%）。`npm test` 连续 3 次全量 0 fail。
- 已知预存 flake（与本改动无关，stash 验证过）：`src/config-backup.test.ts` 的「连写 <60s 不新增备份」用例依赖 mtime/时钟边界，偶发失败、重跑即绿。

## 9. 遗留事项

- 四目标交叉编译 GitHub Actions 发布链（Release 资产 + SHA256SUMS 自动化）——下载链已在 `prepareArchiveTool` 预留，本机产物路径已可用。
- `create` 的条目排序：JS 用 `localeCompare`，Rust 按 bytewise+大小写不敏感序保证自身确定性；两侧产物清单一致（测试断言排序后相等），但 zip 内条目物理顺序可能与 JS 产物不同（不影响任何读取路径）。
- manifest 命令与 `extract` 是两遍解析（先清单后解压）；未来如需进一步压缩导入耗时，可扩展为「边解压边流式吐清单、JS 校验失败即中止」的双工协议（当前导入耗时已较 JS 大幅降低，暂不必要）。
- 本机（无 MSVC Build Tools）使用 `stable-x86_64-pc-windows-gnu` 工具链 + MinGW GCC 链接；有 VS Build Tools 的机器直接用默认 msvc 工具链即可，无需改动 crate。
