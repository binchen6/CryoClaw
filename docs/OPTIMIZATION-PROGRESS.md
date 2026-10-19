# CryoClaw 当前交接与优化进度

本轮交付版本：**2026.1019.0**；上一正式版为 **2026.1018.3**。五轮实质优化涵盖数据保护、键盘与本地化、安装发布、依赖和磁盘文档维护。正式发布以安装、UI、真实消息、CI 与资产验收通过为门槛。

历史阶段、旧测试数量和已闭环问题已移到 [2026.1018.3 及以前记录](archive/optimization-through-2026.1018.3.md)。历史记录不能代替当前状态。

## 本轮五轮范围

| 轮次 | 范围 | 主要修复与验证 |
|---|---|---|
| 1 | 工作区草稿、文件导航与根目录状态 | 备份失败阻止丢弃当前编辑；等待期间的新编辑继续备份；根目录 IPC 串行化，失败退出 loading；行为回归覆盖切换、关闭、编辑和重试 |
| 2 | 会话列表与管理菜单 | 选择和管理改为独立原生按钮；方向键/Home/End/Escape、焦点返回和重命名可访问名；目录选择异步结果按对话框代次隔离 |
| 3 | 工作区与技能选择的双语及键盘体验 | 49 条文案进入双语字典；文件标签方向键与单一 Tab 入口；移除工作区的嵌套交互语义；输入法期间不误触保存快捷键 |
| 4 | 安装、网络与发布验收 | 普通用户 Temp 流式暂存安装器；有界下载与流式摘要；服务端 SHA-256 + 本地清单 SHA-512 联合校验；四路 UI 验收未就绪即失败；真实消息验收成为持久脚本 |
| 5 | 磁盘产物与文档维护 | 默认 dry-run 的白名单清理工具，保护工作区边界与目录链接，保留两版安装包、下载缓存及数据库备份；历史归档、索引和发布说明同步 |

实施与验证细节见 [2026.1019.0 验收记录](RELEASE-2026.1019.0-VERIFICATION.md)。最终回归 1948 pass / 0 fail / 4 skipped；清理 23 项、约 12.41GB。安装、四路 UI、键盘/字体和真实随机回声均通过；远端发布与 CI 状态以该记录中的链接为准。

## 开发与验收命令

```sh
npm test
npm run build
npm run dist:win
node scripts/prune-artifacts.js                          # 只展示计划
node scripts/prune-artifacts.js --apply                  # 清理明确过期的缓存/产物
node scripts/release-assert.js --local-dir out/win32-x64  # 服务端摘要 + 本地清单
```

Windows 沙箱下测试可将 TEMP/TMP 指向工作区的 `.cache/maintenance-temp`，避免临时缓存的 ACL 问题。安装 E2E 必须在获准的普通用户进程中执行；安装脚本会另外使用普通用户 Temp 暂存 exe，不能把安装器暂存根改成低完整性目录。

## 关键路径

| 区域 | 入口与约束 |
|---|---|
| 生命周期、网关、窗口 | `src/main.ts`、`gateway-process.ts`、`window.ts`；窗口先显示，连接状态随后就绪 |
| 配置 | `src/cryoclaw-config.ts`、`openclaw-config-migration.ts`、Chat UI `controllers/config.ts`；写入走内核契约 |
| 草稿与文件 | `src/workspace-files.ts`、`workspace-ipc.ts`、Chat UI `controllers/workspace.ts`；备份、版本 hash、原子替换和根授权各有独立职责 |
| 会话与后台流 | Chat UI `app-session-actions.ts`、`session-transition.ts`、`run-state-store.ts`；异步续体必须检查会话/连接归属 |
| 设置与本地化 | Chat UI `views/settings/settings-view.ts`、`i18n/zh.ts`、`i18n/en.ts`；字典键集合由测试检查 |
| IPC | `src/preload.ts`、`ipc-sender-guard.ts`；以源码白名单和 sender guard 为准 |
| 打包、升级与发布 | `scripts/package-resources.js`、`afterPack.js`、`kernel-updater.ts`、`release-assert.js`；资源完整性、安装版和远端资产均须验证 |
| 清理 | `scripts/prune-artifacts.js`；只清理 `.cache`/`out` 的已知过期子项，不清用户数据、数据库备份或未知目录 |

## 后续变更的规则

- 对异步请求同时检查请求代次和所属连接/会话；有副作用的主进程调用还要保证执行顺序。
- UI 采用设计 token、原生交互控件和中英对称字典；以 800px 最小窗宽检查布局和键盘操作。
- 新发现的非平凡问题要写入 [gotchas](gotchas.md)，不再复制整段历史到当前交接页。
- 发布流程只有 [releasing.md](releasing.md) 一份现行入口；正式版必须同时包含 exe、blockmap、latest.yml。
