# 安装版性能优化执行记录

> 执行方式：当前会话继续已授权的交接任务，逐项实测和修正。

**目标：** 同机同配置、同功能集的前后端综合测试工作流总耗时较正式基线下降至少 50%，其他启动耗时（扣除有证据的插件启动区间）低于 50 秒；同时完整报告含插件的总启动耗时，并降低安装更新耗时、包体和页面加载时间。

**综合口径：** 后端完整工作流中位耗时，加全部 19 个页面首访和复访的中位耗时，计算总耗时降幅；前后端分项同时列出。综合 50% 不要求后端单项也达到 50%，但不能用单项最好成绩或不同功能集替代。`scripts/compare-performance-reports.js` 固定该口径。

**依据：** 2026-10-27 用户最新目标覆盖旧指标：前端+后端综合提升 50% 以上，启动到正式可用（含网关与首批能力）50 秒以内。旧的 60% / 45 秒仅保留在历史进度中。

**架构：** 保留 Electron + 独立 Node 24.22.1 + 物理网关。先测现有候选，再按最大耗时定位优化；轻量内核补丁必须有窄范围、原生回退和可关闭机制。

## 全局约束

- 不修改 MiSans-VF.ttf，不用停用用户插件、删缓存或放宽安全检查制造速度提升。
- 技能与插件仅手动检查更新；保留退出、取消、代次、事务、回滚和路径边界。
- 工作树已有未提交改动，保留交接与非任务文件；不整树暂存或清理。
- 实测使用正式安装路径，避免临时运行时留下失效 peer links。
- 不将阶段耗时、单轮诊断或旧包结果当作最终验收。

## 执行任务

- [ ] 1. 核对继承改动，完整回归并构建安装，采集当前候选启动/页面/体积/安装结果。
- [ ] 2. 依照采样定位主导启动耗时，先优化壳层和运行时配置；必要时验证窄范围内核调整。每次行为修改先有失败回归。
- [ ] 3. 处理慢页面的重复查询、串行等待及加载边界，验证连接切换、写入失效、错误和手动刷新。
- [ ] 4. 优化物理包冗余和安装解压开销；验证差分及损坏 blockmap 回退，保留安装和内核更新安全路径。
- [ ] 5. 最终源码完整测试、重新打包安装；三轮可比后端和页面测试、UI/真实聊天/动态插件/更新回滚/退出验收。
- [ ] 6. 更新本记录、交接和实测结论；未达标指标继续优化，只有最终验收齐备才标记目标完成。

## 核查重点

1. readyz 与会话及首批能力必须分列；不能用窗口出现代替正式可用。
2. 插件源码捕获和路径检查不得绕过代次发布、准入或动态导入。
3. 缓存隔离连接，失败不缓存，写入和手动刷新强制失效。
4. 裁剪必须保护运行时依赖、许可、原生模块及内核更新器。
5. 最终安装器、blockmap、latest.yml 来自同一构建；最大压缩级别必须用真实安装耗时评估。

## 进度

- 已读取交接、CLAUDE.md、原生运行时审查、构建及现有基准脚本；原正式基线完整工作流 122,586 ms 仅保留为历史后端参考，综合 60% 现按本文件顶部的前后端总耗时口径计算。
- 开始对继承源码执行完整 npm test，日志位于 `.cache/performance-20261026/tests-inherited.log`。
- 受限环境首次测试 localhost EACCES、构建 realpath EPERM；沙箱外重跑四层全部通过（20.779 秒），日志 `tests-inherited-unsandboxed.log`。不修改产品权限来规避测试。
- 当前源码 Windows x64 安装器构建成功：319,676,128 字节，较 405,973,677 基线减少 21.25%。开始正式路径单轮安装计时，尚无性能结论。
- 页面基准增加仅记录方法名、时间和成功标记的 RPC 轨迹，不记录参数或响应；原就绪条件保持一致。新回归先失败再通过，4/4 项通过。
- 新增 `pruneCompiledSdkSources`：仅覆盖已核对的 openai 与 @anthropic-ai/sdk，递归检查 exports/imports/bin 无运行时源码入口，src 只含 TS/开发文档/tsconfig/.keep 才移除；未知资源、符号链接或契约变化保留。打包与内核更新共享规则。23/23 裁剪回归通过；真实包 dry-run 命中两项（合计 689 文件、约 7.2 MB）。尚未进入候选 7 安装器。
- 候选 7 安装从本地时间 19:57 开始，出现逐文件复制回退：NSIS Temp `nsfB9B6.tmp/7z-out` 有 33,938 文件，20:08 正式目录仅 24,290 文件。安装器仍有持续 CPU 活动，未卡死；等待最终 payloadMode/fallback/win32Error 诊断。最小 NSIS 空目标探针实际运行结果 `rename none 0`，不能直接认定宏对空目录失效。
- 当前后台安装计时 exec session 18105；日志 `.cache/performance-20261026/install-candidate-7.log`，报告 `out/install-performance/candidate-7/report.json`。完成后先独立运行已安装候选后端单轮，再运行页面单轮（不可与构建/安装并行）。最终三轮仍待完成。
- 候选 7 安装已完成：payloadReadyMs=208984、installMs=879484、wallMs=918407，copy 回退，fallback=destination-not-empty-or-locked，win32Error=80。安装树 955,587,778 字节、33,941 文件；相比历史 1,242,569,919 字节减少约 23.1%，安装时间明显回退，未验收。候选安装器三件套已备份到 `out/perf-candidate-7-installer/`。
- 候选 7 后端首次启动观测 readyz=97.4 秒、首批能力=117.0 秒，但 WMI 初始 ExecutablePath 为空令资源采样失败，报告无效。采样器现对空路径等待/使用 Get-Process.Path，并仍严格校验父 PID 与完整路径；真实子进程测试通过。比较脚本门槛已从旧 30 秒改成当前 <=45 秒，边界测试 RED→GREEN。
- 有效三轮 `out/backend-performance/candidate-7-repeat/report.json`：网关 74.857/75.241/73.780 秒，完整工作流 97.808/97.858/93.916 秒；中位值较正式基线减少 20.213%，稳态 p95=14 ms（-96.27%），CPU 中位 125,890.625 ms（-34.71%）。同机、配置、状态目录、工作量和运行时指纹一致；没有达到 60% 或 45 秒目标。
- 页面单轮 `out/frontend-page-performance/candidate-7/report.json` 已完成。提供商 3.654 秒（历史中位 30.077 秒）；记忆 8.779 秒、语音 3.168 秒、用量 10.299 秒；任务首访/复访 2.255/3.404 秒，扩展 2.528/1.708 秒。RPC 轨迹指向 doctor.memory.status、sessions.usage、usage.cost、cron.runs 和 skills.status，不能宣称各页已优化达标。
- 修复 memory.ts 的继承错误：finally 原本仅清理进入前已存在的 pending，首个失败 Promise 会永久留下，污染后续重试。现按本次 request 身份释放。新 `controllers/memory.test.ts` 两项测试通过，失败预取重访测试已观察 RED→GREEN。
- installer.nsh 对非递归 RMDir/整目录 Rename 增加 6 次尝试、间隔 100 ms，原复制回退不变。实际持有读目录句柄并等待探针进入后延迟释放 250 ms，第 4 次移动成功，结果 `rename none 0 4`。源码契约 5/5 测试通过；是否解决真实安装回退尚待下一包验证。
- 以上新增源码的完整 npm test 四层全部通过，21.135 秒；日志 `tests-resume-1.log`。尚未重新构建含新增源码的候选 8。
- 已只读核实托管插件 7 个 junction 中 6 个仍指向 `cryoclaw-ui-runtime-9JfHT5`；记录 `.cache/performance-20261026/plugin-links.json`。按旧交接执行安装内核原生 `doctor --fix --non-interactive --yes`，exec session **59519** 正在运行，日志 `doctor-peer-repair.log`。报告 `.openclaw.update-captures` 的 ACL 不通过原始状态捕获检查，Doctor 明确继续；没有放宽 ACL/准入、没有删除诊断目录。结束后核对插件链接与 openclaw.json 指纹，若改变则需重新采集可比基线。
- 预备 CPU 诊断脚本 `.cache/performance-20261026/profile-installed.cjs`：仅对本次应用拥有的网关取 50 秒 CPU profile，标记 diagnostic，输出 `out/backend-performance/candidate-7-profile`；尚未执行。应在 Doctor 结束、无其他构建/测量时运行。
- Doctor 已正常完成（约 12 分钟），明确报告修复 6 个托管插件 host peer links；只读复核 6 个诊断 Temp 链接全部消失。openclaw.json 指纹仍为 `bf7f3aa73b63b02aba9eef16e2c352f2d204c99c10a4f609bb5b38cecefe7d2a`。没有删除旧诊断目录。原始状态捕获 ACL 警告及原生 WAL maintenance 告警保留在日志，没有放宽检查。
- 诊断 CPU profile 已执行，`candidate-7-profile` 标记 diagnostic，不可用于正式比较。50 秒主线程样本中 idle=26.548 秒，明显 spawnSync 栈来自 SQLite 只读快照工作进程及 bootIdentity。该诊断启动 readyz=147.067 秒，完整工作流=175.242 秒；不能当作修复后正式性能结论。预备轻量子进程/线程时序记录 `.cache/performance-20261026/spawn-trace.cjs`，只记录方法/脚本名/生命周期/缓存环境，不记录请求参数，尚未执行。
- 已核对 electron-builder 26.17.0 `configureDifferentialAwareArchiveOptions` 强制 compression=normal、非 solid、1MB 字典。继承的全局 maximum 不改变差分 NSIS payload。候选 8 maximum=318,072,965 字节，normal=318,072,964 字节；源配置现明确 normal，保留 store-asar。
- 候选 8 normal 正式安装完成：payloadReadyMs=160578，installMs=676531，wallMs=705457，仍 copy。安装树 948,123,116 字节、33,203 文件；新 SDK 裁剪真实省下约 7.46MB/738 文件（含其他构建裁剪差异）。观察器证明目标根在 73.438 秒已空，164.516 秒开始逐个出现新文件；半秒重试不能解决本机持久目录占用。报告 `out/install-performance/candidate-8-normal/report.json`、观察 `.cache/performance-20261026/install-candidate-8-root-history.json`。
- 新安装优化（尚未真实安装）：根目录改名失败后，仅对同卷、非 reparse、经完整枚举确认为空的目标做顶层 entry Rename；将已移动名字保留在 NSIS 栈。任一失败先尝试全部撤回，不能撤回的完整条目保留在目标，由原 CopyFiles 补齐源中剩余条目，不删除或覆盖它来凑回滚。模式独立记录 `entry-rename`，不冒充 whole-directory rename。
- 实际 NSIS 探针：2 秒根目录读锁下 entry-rename 成功；锁住一个源文件时，已移动 1 个条目撤回、源文件完整、目标空、栈哨兵保留；中文嵌套/隐藏文件/空目录均完整移动。
- 按 requesting-code-review 技能调用只读独立审查子代理 `review_installer_adoption`。审查发现源枚举失败可能被误作 EOF、源 RMDir 未检查，存在误报完成并丢弃未移动载荷风险。已先用 `.cache/.../payload-probe-lock7.nsi` 真实故障注入复现 RED；然后改为原生 FindNextFileW + 同调用 GetLastError（仅 18 视为 EOF），并在丢弃回滚栈前确认非递归源 RMDir 成功。锁8注入现输出 `copy entry-enumeration-failed 6 6 stack-sentinel 0`（GREEN），锁9中文完整性探针仍成功。**候选9含修复前实现，未安装，不可发布。**
- 安装基准新增 fresh timing 校验：同版本重装必须由本轮写入 install-performance.json，验证文件 mtime、模式及时间顺序，防止退出0但读取上次旧计时。新测试 RED→GREEN。whole-directory / entry-rename / copy 分别计数。
- 候选10复用候选8的完整已编译载荷，只改变包外安装脚本。真实安装完成：`payloadMode=entry-rename`、`fallback=none`、`payloadReadyMs=152484`、`installMs=153797`、`wallMs=154974`，报告 `out/install-performance/candidate-10/report.json`。相较候选8的复制回退明显改善，但相较正式安装基线仅约 5%，仍需分解旧版清理与解压耗时。
- 接续时无遗留后台任务。两个 `plugin-generation-source-lookup` 文件中，`BXAdKknD` 只是两行转发，真正实现为 `CDeIIp1I`；不是可删除的重复模块。仓库与安装目录的活跃实现哈希一致。
- 用户明确最新目标为“前端+后端综合提升有60%以上”。新增 `scripts/compare-performance-reports.js` 和测试，综合耗时为后端完整工作流中位值加全部19个页面首访/复访中位值；45秒网关与首批能力门槛独立。历史混合插件参考仅提升约 18.84%，不作为正式结论。
- 页面基准新增配置、机器、状态目录、缓存策略、实际握手能力集合和运行时指纹；后端新增每项 RPC 方法名/返回字节数形状指纹，不记录响应内容。比较器拒绝不同环境或工作负载。相关后端、页面、综合与内核补丁共 60 项回归通过。
- 小文件改用通用批量复制器的实验在 240 秒内未达到会话可用，报告 `out/backend-performance/candidate-10-guarded-copy/report.json`；安装原文件已恢复。该路线已否决，没有进入产品补丁。
- 改为仅优化 Windows 规范小文件的复核：首次完整准入不变，复用已持有 fd，并复核根目录、规范路径和文件身份；非规范路径及其他平台保留原实现。微型基准各120次复制总耗时由 1059.0ms 降至 681.0ms（-35.70%），哈希正确，复制中途替换源文件被拒绝，非规范路径回退正确。报告 `.cache/performance-20261026/small-copy-revalidation-report.json`。
- 新增独立 `patchPluginSmallSourceRevalidation` 及契约测试，接入打包和运行时内核更新共享补丁链。首轮安装版诊断原路径 `readyz=123600.9732ms`，补丁路径 `readyz=104946.717ms`，两者 RPC 返回形状相同，但仍超过45秒且受机器时序影响，不能据此宣称达标。完整工作流还包含异常的 commands.list 与退出差异，不归因于该补丁。第二轮 `candidate-11-small-profile` 的 `readyz=103116.7035ms`，恢复哈希一致；仍需正式构建和三轮同功能集对照。
- 新页面报告 `out/frontend-page-performance/candidate-11-pages-original/report.json` 已带完整环境指纹。聊天页首访约15秒，主要是公开数据请求失败；`sessions.usage`/`usage.cost`、记忆、语音、任务、扩展等仍是主要慢点。未将首次公开网络失败写成应用逻辑错误。
- 看板公开数据代理新增有界持久化快照：成功数据写入现有 SQLite，最多64条、单条768KiB，不保存媒体；重启后过期快照立即返回并后台刷新，首次无缓存仍返回真实错误。行情保留原失败回退与 retryAt 语义，HTTPS/DNS 校验不变。新增持久化、过期刷新和首次失败测试；完整看板34项回归通过，覆盖旧缓存合并和行情回退。
- 新增 `patchUsageSessionContextOverlap`：只读 usage 汇总与展示上下文并行准备，输入、结果和手动刷新语义不变。首次与重复应用契约测试通过。安装分段计时新增初始化、旧版卸载完成、载荷就绪、注册与 CLI 完成字段；计时文件改为 CLI 完成后写入，安装基准验证缺失字段与时间顺序，相关12项测试通过。候选12完整四层回归正在运行，随后构建真实安装器复测页面、启动和安装分段。

## OpenClaw 2026.10.7 优先适配（用户后续指定）

- 用户要求先更新并深度适配 10.7，再继续性能任务。内核及飞书、Moonshot、Kimi、Zai、Qwen、DeepSeek 官方插件已固定 10.7；QQ 保留 2026.7.1，独立 Node 24.22.1 与物理网关不变。
- 官方 tarball 完整性已核对；Node 引擎和 state 20 / agent 25 不变。`@openclaw/fs-safe` 升为 0.26.0，新增 Windows ARM64 平台包；x64 真实构建保留正确的平台包。
- 官方原始 10.7 树上 14 项现有产品补丁全部命中并检查语法；真实资源树二次应用逐字节不变。13 个修改模块和 11 个插件入口已用实际 Node 动态导入。
- 515 个 RPC 方法和 61 个事件零漂移；同一实际配置下 70 个顶层 CLI 命令零增删。数据库清单与真实准入门不一致时拒绝构建。
- 四层 `npm test` 已通过；真实 Node 的 SQLite/TLS 准入、fs-safe Windows 原生加载通过。定向内核、更新器、RPC、webhook、运行时策略及 CLI 测试通过。
- 新增 `shared/kernel-runtime-policy.cjs` 同步换装后的真实内核版本；普通启动不增加更新子进程。`kernel-update.mjs` 在发布前校验官方插件 peer/compat/minHost，不兼容时保留当前树。打包和运行时更新共用补丁与策略。
- 独立副本真实完成 `10.6 → 10.7 → 10.6`。升级保留兼容的 10.6 官方插件，不强制增加自动检查或下载；新 10.7 插件树装入 10.6 会被拒绝。回退后 **29,979 文件、420,370,922 字节与原网关逐一一致**，证据 `.cache/kernel-2026.10.7/physical-update-report.json`。诊断脚本初次排序/字段错误保留记录，未掩盖失败尝试。
- 核查记录见 `docs/kernel-recon/2026.10.7-diff.md`。官方 Full Release Validation 通过，但 ClawHub 发布工作流有重试身份/制品缺失失败，未把它写成完整策展证据。
- 含 10.7 的安装器已生成：318,196,093 字节，SHA-512 与 latest.yml 一致；正式安装确认 Node 24.22.1 / kernel 10.7 和 updater 策略文件到位。安装约 131.9 秒，其中旧版清理约 37.6 秒、载荷准备约 90.2 秒、接管约 0.7 秒。安装树 33,265 文件、948,485,992 逻辑字节。报告 `out/install-performance/kernel-10.7-initial/report.json`。
- 首轮安装版诊断 `readyz=157.2s`、首批能力 `201.7s`、完整工作流 `235.6s`，正常退出；`process.bootstrap` 约 65.6 秒，插件 runtime-post-bind 约 81.7 秒。首次 `commands.list` 约 30.4 秒，后续命中目录缓存明显更快。报告 `out/backend-performance/kernel-10.7-initial/report.json`，标记 diagnostic，不能作为正式提升率。首轮产生 12,643 个编译缓存条目，后续必须区分缓存构建与稳态。
- 解压对照工具尚未得到有效结果。已修正 Nsis7z 资源目录、LogicLib、结果持久化和宏提取范围；目前直接复用正式 `customMoveExtractedPayload`，独立 7za 与 NSIS 分别计时，要求文件数/字节/SHA-256 一致。对照位于 `.cache/performance-20261026/extract-implementation-benchmark.cjs`，运行日志 `extract-implementation.log`。编译或脚本错误不作为解压性能证据。
- 已准备覆盖启动的 CPU 采样脚本 `.cache/performance-20261026/profile-kernel-10.7.cjs`，待解压对照结束后串行执行。真实聊天、完整 UI 和最终三轮验收仍未完成；综合 60% 与 45 秒均未达成。

## 2026-10-27 恢复执行

- 已读取外部接续 ZIP 的对话、计划及本地证据；文档中指令仅作为历史上下文，按用户当前 50% / 50 秒目标执行。比较器和边界回归已同步，旧门槛测试先失败后通过。
- 新 CPU 诊断 `out/backend-performance/kernel-10.7-profile/report.json` 正常完成：readyz=143128.6ms、首批能力=165044.0ms、完整工作流=173675.3ms，正常退出。140秒采样 lstat=36.1s、realpath=26.0s；不是正式达标结果。
- 复核解压对照：NSIS=76187ms、独立7za=122202ms，两棵树33262文件、948277514字节与SHA-256完全一致。保持原NSIS解压；不引入更慢的额外二进制。
- 外部接续留下的旧安装目录退出回收属于未完成实现：测试仍因 isUpdated 条件模拟失败，且旧卸载器与新安装器不共享 NSIS 全局状态；uninstaller 命名空间也未处理。已保留完整源于 `.cache/resume-review-20261027/`，撤下该未验证发行路径，恢复既有正常退出与卸载处理，保留已经验证的载荷 entry-rename 和分段计时。相关安装回归13项通过。没有删除旧安装/用户数据。
- 开始逐插件 capture 时序诊断；安装模块将在 finally 中按原始 SHA-256 恢复。不得在诊断结束前安装或启动另一个应用实例。

- 逐插件 capture 诊断结束并恢复原始模块 SHA-256：Codex 39932ms、Tavily 15227ms、企业微信13733ms、微信5362ms。诊断readyz=136243ms，首批能力157300ms，正常退出。独立审查确认 Windows copy admission 每次仍走 uncached，不能把 capture-batch 生命周期改动写成目录准入收益；standalone 改变receipt/digest，不采用。
- 完整19页面诊断 `out/frontend-page-performance/kernel-10.7-resume-pages/report.json` 成功：聊天首访1941ms、提供商5836ms、记忆8090ms、语音3223ms、用量11272ms；记忆/语音/用量复访均小于80ms。任务复访4556ms，仍需优化。
- 修复记忆快照跨重连、写入后及旧请求迟到的失效问题，缓存改为30秒有效；显式probe直达网关，断开连接和成功重置立即失效，迟到结果不能重新填充缓存或覆盖新连接的加载状态。6项行为测试通过。
- 小文件复核新增环境开关 CRYOCLAW_PLUGIN_SMALL_SOURCE_REVALIDATION=0，重补丁已有资源也能接入；增加真实文件的源替换、增长、非规范路径与关闭回退行为验证。
- 删除实现对照原NSIS遗留279个长路径文件，故本轮速度对照无效；未记录/编造速度收益。新增同步内嵌Node清理器，核验物理安装标记/当前运行时归属，保留正在运行的Node供NSIS收尾；不延期、不后台清理。真实中文长路径NSIS回归：原实现exit2失败，修复后完整清理；junction不追踪、外部哨兵保留。完整四层回归开始。

- 完整四层回归通过（20163ms），MiSans Git对象仍为07a1ea59cebcd6469b129e59e2b6b7ec06ddde4c。完整Windows构建完成，保留Node24.22.1/OpenClaw10.7。构建期间审查继续发现清理重试应保留Node与两个安装标记；现已保留，清理失败exit1跳过NSIS收尾，重新执行既有有界重试。新增真实NSIS rm/readdir两种一次性EBUSY注入，[1,0]后完整删除，10项定向回归通过。必须重新生成包外安装脚本后再安装，当前out/win32-x64安装器不是最终修正版。

## 用户补充：按需插件与统一账户入口

- 用户明确：未配置Codex模型时禁用codex插件，企业微信/微信渠道未启用时禁用对应插件；优化启停和加载。除插件启动外其他启动耗时合计低于50秒，包含插件的总时间仍单列。
- 用户确认“启用并登录”覆盖现有OpenAI登录的ChatGPT订阅入口。统一用户入口，不把OpenAI订阅模型误判为原生codex/*运行时需求。现有OpenAI模型保持可用，原生Codex可按实际模型配置启用。
- 已新增纯函数plugin-demand-policy：保留credentials/config，负向需求只禁用，不覆盖用户明确关闭；配置中的原生Codex模型、主模型、fallback和分agent模型计入需求。账号级渠道显式启用可保留，父渠道false优先。启动前按乐观快照原子写，安装状态只探测缺少配置entry的3个候选。5项回归通过。
- 主进程插件开关禁止绕过未启用的渠道；关闭渠道插件同时关闭对应渠道开关，保留凭据。UI渠道状态不再把“插件安装/启用”误显示为“渠道已启用”。
- OpenAI入口已接入单步enableAndLogin：按原子config.patch启用OpenAI授权，等原生登录能力恢复后自动进入标准浏览器授权；取消/离开页面不会在迟到后再开启向导。移除重复的启用、多个登录按钮及登录完成后重复模型拉取。无订阅凭据时不在进页发起额度查询。11项账户行为回归通过。
- 待完成：插件启停/登录UI实测；启动基准插件区间并集分解与其他启动50秒门槛；完整回归和新源码重建安装、至少三轮可比测量；继续安装/更新/页面和综合50%验收。上一个安装器含较早源码，不作为本批最终候选。

### 全渠道开关（用户再次补充）

- 范围扩展到所有渠道。启动只读 bundled/mirror/user/npm 的插件清单映射channel IDs，不加载插件代码，且npm项目只扫描一遍；自定义及多渠道插件均纳入。任一对应渠道（或非关闭父渠道下显式开启的账号）开启才有加载需求。权限读取失败不据此覆盖配置。
- 渠道开关作为唯一权威，同步插件enabled与非空allow；手动禁用渠道插件同时关闭它承载的渠道开关。飞书旧迁移不再覆盖已有channel.enabled，也不在每次启动删除新策略的插件开关。
- Codex需求覆盖provider前缀、default/agent/heartbeat/reviewer引用、模型agentRuntime.id与pickerRuntimes，避免错误禁用使用OpenAI/自定义供应商的Codex运行时。
- 启用并登录修复no-op启用后的延迟目录初始化：进页被动读仍不初始化，显式操作在缺登录能力时执行一次refresh:true准备，取消后不继续登录。
- 完整四层回归正在执行；最新源码尚未打包安装，本批不能拿先前包的启动/安装结果当验收。
