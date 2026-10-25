# 2026-10-24 暂停交接

用户要求：完成当前安装速度实测后暂停，明天继续。目标版本仍为 **2026.1023.1**。**尚未发版、尚未提交或 push 本版改动**；当前公开 latest 仍为 [2026.1023.0](https://github.com/binchen6/CryoClaw/releases/tag/v2026.1023.0)。

## 已实现及验证

- 独立看板 21 张示例、SDK v2、离屏停帧、真实音频频谱、节奏和调色持久化、可打断展开/恢复、目录缓存、共享对话输入、原生任务联动、归档后删除与边界保护。详见 [本版审查](REVIEW-2026.1023.1.md)。
- 模型与推理强度合并菜单，无模型介绍；右上角为原生会话快速模式开关。键盘、Escape、快速反转、减少动态效果和真实持久化实测 7 项通过。已移除看板输入框重复白色外层。
- 开发实测看板 14 项通过，真实模型通过共享输入在同一会话发布指定看板。证据：`out/dashboard-v2-review/2026-10-23T15-45-03-540Z/report.json`、`out/dashboard-v2-review/model-picker-1792770294704/report.json`、`out/dashboard-v2-review/shared-model-1792768677594/report.json`。
- 清除之前遗留的 14 个 QA 对话、11 个 QA 看板和 1 个停用 QA 任务。测试创建即记录归属，启动恢复清理和 finally 收尾，刷新列表；保留真实用户记录。最终安装验收后仍需再核实活动/归档 QA 均为 0。
- 修复票据日志泄漏、同 ID 卡片重建票据复用、诊断日志整读、失效旧 ASAR 向量 DLL 路径及启动失败误报。
- 开发根项目、UI、网关、内核更新器四棵锁文件审计均为 0；已枚举发布资源中的相关副本，更新器 brace-expansion 也为 5.0.12。运行时 npm 11.21.1、网关 npm 12.2.1、IP parser 10.7.4、Undici 7.29.1/8.11.2。八个 Windows 原生模块实际加载成功。
- **最新完整回归 2175 pass / 0 fail / 6 skip**，约 21.5 秒；这是新增安装/更新性能改动之前的完整结果，不能作为最终版本的完整门禁。

## 最后新增的安装、更新与退出优化

1. 用户追加要求深度优化安装、更新与退出速度。安装基线约 **14 分 50 秒**；文件创建时间线显示目标目录逐文件复制阶段约 11 分钟。electron-builder NSIS 先解压到临时目录，再 Shell CopyFiles 全树。
2. 已在现有受保护 NSIS 模板适配器中增加 `customMoveExtractedPayload`：仅空目标、同磁盘且目录可整体 rename 时直接接管完整解压目录；非递归 RMDir，失败保持原复制/重试路径。保留 7z 与差分下载，没有改成全量 ZIP 更新。加入安装性能 JSON。
3. 内核更新 staging 改为原生网关同一磁盘的私有临时目录；`swapDirectory(...,{moveCandidate:true})` 消费更新 staging，减少一次完整复制。跨磁盘回退复制，回滚默认仍复制备份，保留 journal/恢复与完整性检查。
4. `electron-builder.yml` 已选择 `differentialPackage: store-asar`，供后续更新保持 app.asar 的稳定字节成员。**此项是在当前性能测试安装器打包后修改，尚未进入测试安装器，也未完成最终发版打包验证。**
5. 上述 NSIS 和目录事务相关 **11 项定向测试通过**，完整回归尚需重跑。
6. 退出基线：安装版正常启动后，退出 **12015ms，exit=0**。第二次诊断运行约 21844ms，期间有打包 CPU 竞争及诊断开销，不能与第一轮直接当作优化对照。
7. 已定位主要等待在原生清理：prepared-models、metadata-retirement，以及 `openclaw.nativeWorkerLifetimes`（约 6 秒）。该最后阶段通过 spawn broker 回收原生资源；宿主保留 non-detached 子进程完整宽限。**尚未修改该安全边界，也未实现退出提速。** 后续需保留数据库 clean-close、资源回执、任务/子进程清理，不能直接缩短所有超时或强杀冒充优化。

## 当前操作与证据

- 已完成的安装速度实测：`node .cache/install-speed.cjs`，终端 session **20471 已退出，code=0**。总耗时 **845540ms（14 分 5.5 秒）**。日志 `.cache/install-speed.log`，完成结果 `.cache/install-speed-result.json`。安装版 2026.1023.1、Node 24.22.1 与 OpenClaw 2026.10.6 校验通过。
- 性能测试安装器：`out/installer-speed/CryoClaw-Setup-2026.1023.1-x64.exe`，预打包自旧的 win-unpacked，只用于验证安装流程；**并不包含刚新增的内核 staging/目录接管与 store-asar 配置，不可直接发布**。
- 安装器内部性能文件：`C:/Users/binchen/AppData/Local/Programs/CryoClaw/resources/install-performance.json`。实测 **payloadMode=copy**，目录 rename 快路径未命中。payloadReadyMs=182984、installMs=808093，解压就绪后的阶段仍约 10 分 25 秒。**当前不能宣称目录接管已实现提速，明天先诊断其回退原因。**
- 原始安装时间线 `.cache/install-timeline-1023-1.json`；退出基线 `.cache/exit-baseline-1023-1.json`；诊断 `out/exit-review/1792773234243/report.json` 与 `shutdown-resets.jsonl`。诊断仅对本次确认的 gateway 子进程内存注册表做临时计时，没有修改已安装内核源码。
- 最终资源安全清单 `.cache/resource-security-inventory-1023-1.json`；四棵审计 `.cache/audit-{root,ui,gateway,updater}-1023-1-after.json`；全量回归 `.cache/test-1023-1-release-final.log`。
- 既有 `.cache/verify-release-1023-1.cjs` 是待最终验收后使用的证据汇总器，依赖尚不存在的 `.cache/installed-1023-1-final-qa.log`，目前不能当作已通过。

当前操作已结束，任务按用户要求暂停；没有继续启动应用、测试、提交、发版或 push。

## 明天继续的顺序

1. 先读当前实测结果和性能 JSON，确认目录接管是否生效。补齐可靠的成功/回退诊断，必要时修复，再比较相同安装位置的真实耗时。
2. 深入解决退出关键路径，保留真实清理与失败反馈；补充早退、重复退出、在途启动/更新的回归，并做真实退出对照。
3. 完整回归；最终 `npm run dist:win`（TEMP/TMP 使用 `.cache/build-tmp`，npm cache `.cache/npm`），只认最终源码构建的安装器。
4. `scripts/silent-install.js` 安装并等待终端明确结束，禁止半安装时启动应用。核对安装版 app.asar/全部资源摘要与实际 Node、内核、原生模块和 SQLite vector。
5. 共享启动门禁可用：`scripts/dashboard-deliverables-cdp-smoke.js --exe <installed> --in-place --dashboard-v2 --release-ui`，按需增加 `--live-dashboard --live-query --live-cron --live`，启动重复样本和停止均需真实测量。它会执行 14 项看板、7 项新菜单及全 UI 场景，并 finally 清理。
6. 核实活动及归档 QA 会话/看板/任务为 0，恢复用户选择和草稿；补充审查、进度和发布说明的最终证据。
7. 只提交本任务文件，push、草稿三资产校验、发布、同步 website/release.json 和文档。用户要求 **push 后不追加 CI 等待、更新发现或其他核验**。

## 工作区与发布注意

- main 基线 6064328；本版改动未提交。勿 `git add .`。
- 用户独立宣传工作必须保留：README 的宣传改动、`.zcode/`、`.zcodeignore`、`docs/promo.md`、`output/`、`scripts/*promo*`、`website/promo/`。README 仅本任务版本提示应构造 index patch 单独暂存。
- `.0` 安装包与公开 release 不动。当前 `out/win32-x64` 中 `.1` 安装包是新增速度优化之前的候选，不得误发布。
- Git push 使用临时 `http.proxy=http://127.0.0.1:7688`；GitHub 插件支持读取，发布写操作用已有 CLI 认证，不打印 token。
- `npm test` 需合适权限；构建时 TEMP/TMP 必须使用工作区目录。工作区 Node 带低完整性标签，开发启动使用已安装同版本正常 Node 的忽略脚本；最终安装版验收不走开发 shim。
