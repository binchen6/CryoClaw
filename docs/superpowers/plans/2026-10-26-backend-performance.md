# 性能优化交接（2026-10-26，暂停）

> 2026-10-30 已接续。以下正文保留为历史交接，不代表当前工作暂停或当前内核版本。最新授权取消固定秒数/提升比例硬要求，继续优化并优先保持稳定。源码现钉定 OpenClaw 2026.10.9，应用候选 2026.1030.0；最新修复与最终包验收状态见 [优化进度](../../OPTIMIZATION-PROGRESS.md)。中间候选的构建、安装、聊天和测量不能代替最新源码的重新验收。

## 状态与边界

**当前是暂停的工作树，不是可发布候选版。未提交、未推送、未创建 Release。**

用户最新约束：

- 首要目标是高稳定性、流畅性、可扩展和可维护性。
- 内核只允许少量轻量补丁；不要为凑指标继续扩大补丁面。后续优先非内核优化。
- `chat-ui/ui/public/fonts/MiSans-VF.ttf` 不压缩、不转 WOFF2、不子集化、不重编码，保留可变字重。
- 技能和插件不做进入页面、更新完成或后台定时自动更新检查；保留用户手动检查。
- 原目标：整体后端耗时下降 60% 以上、网关启动和首批能力均小于 30 秒。**目前没有达到这些目标，不能宣称完成。**

## 已保留的改动

### 少量轻量内核及构建适配

- `shared/gateway-core-resolution-cache.cjs`：仅对本次安装的核心 `openclaw/dist` 文件建立解析清单。精确 `.mjs` 相对导入走清单；外部包、别名、自定义 conditions、import attributes、未知文件仍走原生解析。保留后续 owner hook 和准入。`CRYOCLAW_CORE_RESOLUTION_MANIFEST=0` 可关闭清单，`CRYOCLAW_DISABLE_CORE_RESOLUTION_CACHE=1` 可全部关闭。
- `shared/openai-proxy-bootstrap.cjs` 接入上述清单；`scripts/afterPack.js` 将该模块复制进包外资源。
- `scripts/lib/kernel-dist-patch.js` 的 `patchPhysicalDesktopKernel` 与旧 ASAR 路径分离，运行时内核更新也走物理路径：
  - `patchLazyControlUiRetention`：健康的 bundled Control UI 不做所有历史资源的全量预校验。仅在当前包缺少某个静态资源、确实需要回退旧资源时，才执行原有完整校验；保留取消、失败降级和原子发布。
  - `patchCommandCatalogCache`：5 秒、16 项的命令目录缓存，按配置、技能源/快照和插件代次失效；失败不缓存、并发去重。
  - `patchPluginCopyBatchLifetime`：在单个 source capture 生命周期内复用目录准入批次，捕获销毁时关闭；没有删除边界检查。
  - 保留此前的选择性 provider discovery、可信搜索入口和 Windows 原生 canonical path 小补丁。
- `scripts/package-resources.js`：物理/旧 ASAR 补丁分流；将内核补丁内容哈希纳入 `.gateway-stamp`，防止撤回补丁后复用旧资源树。更新器依赖使用内容戳跳过重复 npm install。
- `scripts/lib/bundle-plugin-entry.js`：使用 esbuild 官方 `write:false` 返回产物，再由构建 Node 进程写入，修复当前机器低完整性 esbuild 无法写普通 Temp 的问题；不修改依赖二进制或 ACL。
- `scripts/afterPack.js`：不再把本地 QA 的 `electron-worktree-low.exe` 带入正式包。该文件实测为 **239,500,288 bytes**，仅删除打包输出中的无用副本，不影响运行时。
- `electron-builder.yml`：`compression: maximum`，Windows/macOS 仅保留 `en-US`、`zh-CN` Electron locale。
- 保留独立 **Node 24.22.1 + 物理网关**。未采用 Electron 替换独立 Node 的高风险方案。
- `scripts/prune-artifacts.js` 支持清理明确的历史重打包临时产物；目前仅 dry-run，**没有执行删除**。

### 页面和更新检查

- `controllers/tasks.ts`、`cron.ts`、`skills.ts`：每连接 10 秒短缓存；写操作、手动刷新、cron 事件、技能导入均强制失效。保持原请求时序，不吞错。
- `subscription-account.ts`：进入页面自动 `sync(false)`，手动同步仍强制刷新。
- `subscription-auth.ts`：账户快照返回后，额度与模型/配置查询并行执行；登录 wizard 的所有权、取消和重连语义不变。
- `controllers/memory.ts`：同连接共享进行中的 `doctor.memory.status` 请求，强制刷新在旧请求之后执行。`page-preload.ts` 仅在悬停/键盘聚焦记忆设置项时预取，不后台轮询。
- `app-skills.ts`：移除进入 tab、首次渲染及更新完成后的自动检查。手动“检查更新”保留；插件检查也只在 `@click` 中触发。
- `MiSans-VF.ttf` 的 Git 对象与 HEAD 完全一致：`07a1ea59cebcd6469b129e59e2b6b7ec06ddde4c`。没有修改字体。

### 已撤回，勿直接复活

- 模型运行时 `selectPluginGeneration` 复用尝试：未发布必需的 inbound plugin registry，导致 `prepared inbound plugin registry was not published`。相关实现和测试已移除。
- `patchTrustedNativeGlobalLoader` 全局原生加载尝试：没有证明简单、稳定、有效，已完整移除实现、导出、调用和测试；诊断副本也已恢复原加载文件。不要继续扩大这条路线。

## 实测证据（不要把历史候选当成当前完成版）

### 正式基线与较早候选（各 3 次，正常退出）

报告：

- `out/backend-performance/baseline-2026-1025-0/report.json`
- `out/backend-performance/candidate-2-staged/report.json`

| 指标 | 基线 | 较早候选 | 变化 |
|---|---:|---:|---:|
| 完整工作流中位值 | 122,586 ms | 68,847 ms | **-43.84%** |
| readyz 中位值 | 53,207 ms | 49,773 ms | -6.45% |
| 稳态 RPC p95 | 375.6 ms | 132.6 ms | **-64.70%** |
| 网关观测 CPU | 192,828 ms | 91,375 ms | **-52.61%** |
| 峰值工作集（约） | 1.70 GB | 1.70 GB | 基本持平 |

- 较早候选仍未达到 60% 总体目标，readyz 未低于 30 秒；首轮能力最大值为 **87,138 ms**，也未达标。
- **这些不是当前最终源码的性能结果**。最终源码仍需重新打包、安装并测量。

### Control UI 专项轨迹

- 原 `sidecars.control-ui-assets` 曾约 **88.9 秒**，逐个校验/复制约 700 多个文件。
- 按需校验后，诊断轨迹中该阶段为 **0.2 ms**。这是阶段性诊断，不是完整 60% 启动承诺。
- 后续全局插件源码捕获仍是主要瓶颈。已停止继续叠加该方向的内核补丁。

### 页面基线，不是优化后结果

`out/frontend-page-performance/baseline-2026-1025-0/report.json`：

- 设置-提供商首访约 **30,077 ms**。
- 记忆首访约 **3,610 ms**；用量约 **4,896 ms**；语音约 **1,567 ms**。
- 任务首访/复访约 **2,199/1,335 ms**；扩展约 **1,768/977 ms**。
- 当前修改已通过 Chat UI 测试，但尚未在最终安装版复测这些页面。

### 安装、存储和更新基线

- 安装器：**405,973,677 bytes**。
- 安装目录：33,944 文件、4,051 目录、逻辑大小 **1,242,569,919 bytes**。
- locales：**48,911,733 bytes**；待验证裁剪后的实际值。
- 实测安装 `payloadReadyMs=161,344`、`installMs=162,188`、`payloadMode=rename`。
- 正常差分基线：安装器数据 **3,121,897 bytes**，约 **812 ms**，SHA-512 通过。
- 故意损坏 blockmap 的完整回退：**405,973,677 bytes**，约 **1,130 ms**，SHA-512 通过。
- **尚未生成当前最终安装器，也没有最终安装/更新速度或体积对比。最大压缩级别对解压时间的影响必须实测。**

### 验证状态

- 最近 `npm run build`：通过。
- 最近 `npm run test:chat`：**1,279 项通过**。
- 最近 `node --test scripts/kernel-dist-patch.test.js scripts/backend-performance-benchmark.test.js`：**51 项通过**。
- `test:scripts` 在修复 esbuild 后：**324 项中 322 通过、2 项按条件跳过**。
- `npm test` 曾先通过其他层、因低完整性 esbuild 写文件失败；随后已修复该层并通过。**最终修改后的完整 `npm test` 尚未重新执行，不能声称完整回归已通过。**
- 未执行最终安装版 UI、真实聊天、插件动态导入、内核更新/回滚验收。
- 当前没有后台任务在运行。

## 接续注意事项

1. `out/perf-candidate-*` 和 Temp 中的是实验产物，不是最终发行版。`out/win32-x64` 旧安装器属于基线，不代表当前源码。
2. `package.json` 和 lockfile 已推进到 `2026.1026.0`，但对应 `release-notes.json` 双语条目尚未补齐。应在真实验收后更新发布说明和实测文档。
3. **不要直接删除 `C:/Users/binchen/AppData/Local/Temp/cryoclaw-ui-runtime-9JfHT5`**：当前生成插件的 peer links 仍指向这个诊断目录。它没有正在运行的进程，但若删除而未先修复链接，会破坏插件加载。
4. 后端基准已拒绝 `--stage-runtime`，避免临时目录删除后留下失效 peer links。最终测试直接针对正式安装目录。
5. 若确需删除上述诊断目录，先使用已安装内核的原生安全修复，不用 `--force`，不删除用户配置：

   ```bash
   OPENCLAW_NO_RESPAWN=1 CRYOCLAW_OPENAI_GATEWAY_ROOT='C:/Users/binchen/AppData/Local/Programs/CryoClaw/resources/resources/gateway/node_modules/openclaw' \
   'C:/Users/binchen/AppData/Local/Programs/CryoClaw/resources/resources/runtime/node.exe' \
     --require 'C:/Users/binchen/AppData/Local/Programs/CryoClaw/resources/resources/openai-proxy-bootstrap.cjs' \
     'C:/Users/binchen/AppData/Local/Programs/CryoClaw/resources/resources/gateway/node_modules/openclaw/openclaw.mjs' \
     doctor --fix --non-interactive --yes
   ```

   该命令可能执行受支持的安全迁移并花数分钟。完成并核对插件后再决定删除诊断目录。若配置或插件库存变化，重新采集可比基线，不直接比较旧报告。

## 建议的接续顺序（非内核优先）

先完成真实构建、安装与页面验收，再判断是否需要任何进一步工作；不要为数字继续加补丁。

```bash
npm run package:resources -- --platform win32 --arch x64
npm run build
npm test
git diff --check
npm run dist:win:x64
node scripts/silent-install.js out/win32-x64/CryoClaw-Setup-2026.1026.0-x64.exe 2026.1026.0
```

然后针对**正式安装版**执行：

```bash
node scripts/backend-performance-benchmark.js --exe "$LOCALAPPDATA/Programs/CryoClaw/CryoClaw.exe" --runs 3 --label candidate-final --out out/backend-performance/candidate-final
node scripts/frontend-page-performance-cdp-benchmark.js --exe "$LOCALAPPDATA/Programs/CryoClaw/CryoClaw.exe" --runs 3 --label candidate-final --out out/frontend-page-performance/candidate-final
node scripts/install-performance-benchmark.js --installer out/win32-x64/CryoClaw-Setup-2026.1026.0-x64.exe --version 2026.1026.0 --runs 3 --out out/install-performance/candidate-final
node scripts/distribution-size-report.js --installer out/win32-x64/CryoClaw-Setup-2026.1026.0-x64.exe --install-dir "$LOCALAPPDATA/Programs/CryoClaw" --out out/distribution-size/candidate-final.json
node scripts/release-ui-smoke.js --exe "$LOCALAPPDATA/Programs/CryoClaw/CryoClaw.exe"
node scripts/live-chat-cdp-smoke.js --exe "$LOCALAPPDATA/Programs/CryoClaw/CryoClaw.exe" --live
```

- 用 `scripts/update-download-benchmark.js` 验证正常差分和损坏 blockmap 的完整回退；先查看其 `--help` 获取当前参数。
- 核对插件动态 import、内核更新/回滚和干净退出，不只做 import/编译检查。
- 按最终实测更新架构、发布、优化记录与 gotchas；不把历史候选或未验证修改写成完成版。
- 若 60%/30 秒仍未达到，明确报告未达标；优先保持稳定性，不再用扩大内核补丁的方式凑指标。
