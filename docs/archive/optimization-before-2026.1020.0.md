# CryoClaw 优化进度

当前基线：**2026.1019.0**。2026.1018.3 及以前的五轮优化、测试基线与已闭环问题见
[历史归档](optimization-through-2026.1018.3.md)；2026.1019.0 的安装、四路 UI、
真实消息与发布验收细节见 [验收记录](../RELEASE-2026.1019.0-VERIFICATION.md)。本页只记录
当前优化循环的新增改动与下一轮候选。

## 优化循环记录

### 第 1 轮 · 2026-10-20

- **问题**：中文/日文输入法组词时按 Enter 选择候选，会把候选提交误当成操作确认。
  目标表单（`/goal`）会立即发送未完成的目标；模型别名、自定义分组新建/重命名输入框
  会提前保存。
- **改动**：在 `chat-compose.ts` 的目标输入和 `tab-provider.ts` 的别名/分组
  新建/重命名输入上，先判断 `isComposing || keyCode === 229`，组词期间不处理 Enter；
  新增 `ime-enter-guards.test.ts` 锁定这四处入口。
- **验证**：`npm run test:chat` 1124 pass / 0 fail（含新增 2 条 IME 回归）；
  `npm run build` 通过；Vitest 基线 276 pass / 0 fail。
- **遗留问题**：记忆检索输入框（`tab-memory.ts`）仍有同样的 Enter 未设 IME 守卫；
  全量 `npm test` 的 scripts 层在本机沙箱有 2 条既有失败（gotcha #139/#140，非代码回归）。
- **下一轮候选**：补齐记忆检索的 IME 守卫；修复消息悬浮操作行展开时 24px 布局跳动；
  为「本轮改动」浮层增加点击外部/Esc 关闭。

### 第 2 轮 · 2026-10-20

- **问题**：会话管理里的行内重命名与「新建工作区」对话框同样在输入法组词时响应
  Enter/Escape：重命名会提前结束，新建对话框会提前提交或关闭。
- **改动**：`oc-session-panel.ts` 的重命名键盘处理与工作区对话框容器键处理加入
  `isComposing || keyCode === 229` 守卫；IME 回归测试扩展到这两个入口。
- **验证**：`npm run test:chat` 1125 pass / 0 fail；`npm run build` 通过。
- **遗留问题**：记忆检索输入与技能商店搜索仍缺少同类守卫；全量 `npm test` 的
  scripts 层仍有 2 条沙箱既有失败。
- **下一轮候选**：收起剩余两处 IME 守卫，随后处理消息悬浮操作行的布局跳动。

### 第 3 轮 · 2026-10-20

- **问题**：记忆检索输入框和技能商店搜索框仍会在输入法组词确认时触发检索；
  这是上一轮同类缺陷的最后两处。
- **改动**：`tab-memory.ts` 的记忆检索与 `app-skills.ts` 的商店搜索加入
  `isComposing || keyCode === 229` 守卫；IME 回归测试覆盖两处入口。
- **验证**：`npm run test:chat` 1126 pass / 0 fail；`npm run build` 通过。
- **遗留问题**：消息悬浮操作行仍会在展开时把后续内容下推 24px；自定义主题删除
  没有确认步骤。
- **下一轮候选**：为自定义主题删除增加确认与结果提示。

### 第 4 轮 · 2026-10-20

- **问题**：主题库中的自定义主题点击「删除主题」立即生效且无任何确认，误点会永久
  丢失用户保存的主题包。
- **改动**：删除前走统一确认弹窗（危险样式），确认后删除并给出成功 toast；新增中英
  文案 `settings.appearance.deleteTheme*` 三条。
- **验证**：`npm run test:chat` 1126 pass / 0 fail（i18n 键集合检查通过）；
  `npm run build` 通过。
- **遗留问题**：消息悬浮操作行展开仍有 24px 布局跳动；「本轮改动」浮层缺少
  点击外部/Esc 关闭。
- **下一轮候选**：让「本轮改动」浮层支持点击外部与 Esc 关闭并归还焦点。

### 第 5 轮 · 2026-10-20

- **问题**：「本轮改动」文件浮层点击展开后，只能再次点摘要收起；点击空白处或按
  Esc 不会关闭，键盘用户也没有明确的退出路径。
- **改动**：`oc-turn-files.ts` 在连接时监听文档级 pointerdown/Escape，点击浮层外部
  关闭；Esc 关闭并把焦点还给摘要按钮；断开时移除监听。新增行为回归测试。
- **验证**：`npm run test:chat` 1128 pass / 0 fail（含新增 2 条）；`npm run build` 通过。
- **遗留问题**：消息悬浮操作行展开仍有 24px 布局跳动；主题 Agent 预览的 60 秒
  自动恢复可能在用户开始手动微调后仍触发。
- **下一轮候选**：用户一旦手动微调主题预览，就暂停自动恢复倒计时。

### 第 6 轮 · 2026-10-20（验证失败，已回滚）

- **问题**：主题 Agent 预览的 60 秒自动恢复会在用户开始手动微调后继续倒计时，可能
  丢弃编辑。
- **改动（已回滚）**：在 `theme-live.ts` 的手动编辑、设置页微调、元素点选三处暂停
  自动恢复计时，并新增回归测试。
- **验证结果**：`npm run test:chat` 失败。新增源码断言按 LF 匹配，而 `theme-live.ts`
  使用 CRLF，导致误报；`npm run build` 通过。已回滚 `theme-live.ts` 并删除新增测试，
  工作区无残留。
- **遗留问题**：该问题仍未修复；其余候选同上。
- **下一轮候选**：用不依赖行尾的断言重试本轮修复。

### 第 7 轮 · 2026-10-20（重试第 6 轮）

- **问题**：主题 Agent 预览的 60 秒自动恢复会在用户开始手动微调后继续倒计时，可能
  丢弃编辑。
- **改动**：`theme-live.ts` 新增 `pauseAutoRestore`，在设置页微调、实时编辑器改动、
  元素点选三处清除自动恢复计时；回归测试改为先统一换行符，避免 CRLF 误报。
- **验证**：`npm run test:chat` 1129 pass / 0 fail；`npm run build` 通过。
- **遗留问题**：主题实时编辑器打开后焦点仍留在触发按钮上；消息悬浮操作行有
  24px 布局跳动。
- **下一轮候选**：把焦点移入主题预览面板，关闭时归还触发元素。

### 第 8 轮 · 2026-10-20

- **问题**：打开实时主题编辑器或 Agent 预览后，键盘焦点仍留在背后的页面；用户需
  要穿越大半个页面才能到达编辑器，关闭后焦点也不会回到触发按钮。
- **改动**：`theme-live.ts` 记录打开前的焦点，渲染后把焦点移入编辑器（无编辑器时
  移入预览条），退场完成后归还；两处容器加 `tabindex="-1"`，CSS 去掉整块焦点环。
  新增焦点行为回归测试。
- **验证**：`npm run test:chat` 1131 pass / 0 fail；`npm run build` 通过。
- **遗留问题**：消息悬浮操作行展开仍有 24px 布局跳动；概览页复制路径失败时没有
  任何提示；全量 `npm test` 的 scripts 层仍有 2 条沙箱既有失败。
- **下一轮候选**：概览页复制失败改为全局错误提示。

### 第 9 轮 · 2026-10-20

- **问题**：概览页复制路径失败时异常被空 catch 吞掉，按钮没有任何反馈，用户会误以为
  已复制。
- **改动**：`copyPath` 失败时调用全局错误 toast；新增中英文案
  `settings.overview.copyFailed`。
- **验证**：`npm run test:chat` 1131 pass / 0 fail（i18n 键集合检查通过）；
  `npm run build` 通过。
- **遗留问题**：消息悬浮操作行仍有 24px 布局跳动；重复出现同一条通知时不会重置
  自动消失计时；全量 `npm test` 的 scripts 层仍有 2 条沙箱既有失败。
- **下一轮候选**：重复通知重新计时，避免连续报错被过早收起。

### 第 10 轮 · 2026-10-20（验证失败，已回滚）

- **问题**：同一条 toast 在展示期间再次出现时直接去重返回，不重置自动消失计时；
  连续报错可能在旧时限到达时被过早收起。
- **改动（已回滚）**：`app-toast.ts` 抽出 `scheduleDismiss`，重复提示时重新计时；
  `app-toast.test.ts` 增加 mock timer 回归。
- **验证结果**：`npm run test:chat` 失败。新增用例在虚拟时钟前进后仍能读到消息，
  说明测试没有覆盖嵌套的 200ms 退场移除计时；`npm run build` 通过。已回滚两个文件，
  工作区无残留。
- **遗留问题**：重复通知仍沿用旧时限；其余候选同上。
- **下一轮候选**：用分步推进虚拟时钟的断言重试 toast 计时修复。

### 第 11 轮 · 2026-10-20（已按用户要求回退）

- **问题**：消息悬浮操作行在 4px 与 28px 之间过渡，实测会把页脚和下一组整体下推
  24px（页脚 217→241，下一组 261→285），阅读时画面跳动。
- **改动（已回退）**：曾让操作行始终预留 28px、移除悬停高度过渡，并用
  `.chat-group:has(.chat-message-actions)` 抵消原组间距；同时新增布局契约测试。
- **验证与回退**：改动期间真实 Electron 窗口 + CDP 测得 shift=0、操作行 28px；
  按用户要求已将 `chat.css` 与 `layout-qa.test.ts` 恢复到改动前，并重新构建。
- **回退后验证**：`npm run test:chat` 1131 pass / 0 fail；`npm run build` 通过。
- **遗留问题**：消息悬浮操作行仍会下推 24px（已恢复原有行为）；默认模型耗时与
  重复通知计时仍待处理。
- **下一轮候选**：隔离 home/锁目录后打通探针网关，测量并优化「设为默认模型」反馈。

## 当前状态

23 轮中 19 轮通过并保留、3 轮（第 6、10、11 轮）验证失败或按要求回退、1 轮（第 19 轮）
为观察收尾轮，无带病代码。第 20 轮起按用户要求开启新一轮 UI 深度优化循环
（计划第 20–27 轮，第 20 轮为用户点名的工具调用展示/折叠深度优化）。
最新回归：Chat UI 1143 pass / 0 fail，Vitest 276 pass / 0 fail，node:test 376 pass /
0 fail（含 IPC guard 覆盖契约与 preload↔main 通道/文档对齐契约），`npm run build` 通过
（沙箱内需将 TEMP/TMP 指向 `.cache/maintenance-temp`，否则 esbuild 删临时文件被 ACL 拒绝）。
`docs/ipc-api.md` 已与 preload 全量对齐（142 调用 + 9 事件通道）。
默认模型反馈耗时仍待探针网关打通后测量。完整 `npm test` 的 scripts 层在本机沙箱仍有
2 条既有失败（gotcha #139/#140），需在正常桌面/CI 环境复跑。

### 第 12 轮 · 2026-10-20（暂停，未改代码）

- **观察**：打通真实 Electron + CDP 探针，完成第 11 轮的窗口级验证（该轮随后按用户
  要求回退）；开始排查探针网关，系统 Node 24.14 因 `node:sqlite` 缺陷被内核拒绝，
  应用自带的 Electron Node 24.22 可通过该检查，但网关仍在 bootstrap 阶段静默失败，
  疑与本机状态/锁目录有关。
- **决策**：按用户要求当前轮收尾后暂停，不启动默认模型优化，避免在未打通的链路上盲改。
- **改动**：无。
- **验证**：探针进程已停止，含凭据的临时状态目录已删除；回退后回归见上。
- **下一步**：恢复后先把 HOME/USERPROFILE/LOCALAPPDATA 与内核锁目录一起隔离，
  再测量「设为默认模型」耗时；随后补测重复通知计时。

### 第 13 轮 · 2026-10-20（重试第 10 轮）

- **问题**：同一条 toast 在展示期间再次出现时直接去重返回，不重置自动消失计时；
  连续报错可能在旧时限到达时被过早收起。
- **改动**：`app-toast.ts` 抽出 `autoDismissDelay`/`scheduleAutoDismiss`，去重命中时
  普通 toast（无 action）清掉旧计时并重排全时长；带 action 的常驻 toast 维持原样。
  `app-toast.test.ts` 新增回归：用 `t.mock.timers` 分步推进（7s→重现→再 7s 仍在→
  满 8s 进入退场→再走 200ms 移除），覆盖了第 10 轮漏算的嵌套退场计时。
- **验证**：`npm run test:chat` 1132 pass / 0 fail；`npm run build` 通过
  （首次构建因系统 Temp 的 ACL 拒绝 esbuild 删文件而失败，按本页既有做法隔离
  TEMP/TMP 后通过，与代码无关）。
- **遗留问题**：默认模型反馈耗时待探针网关打通后测量；scripts 层 2 条沙箱既有失败。
- **下一轮候选**：隔离 HOME/锁目录后打通探针网关，测量并优化「设为默认模型」反馈。

### 第 14 轮 · 2026-10-20

- **问题**：「新建工作区」对话框脱离 dialog-a11y 契约——`role="dialog"` 挂在内层卡片且
  无 `tabindex="-1"`，打开时全局焦点引导的 `focus()` 静默失效（焦点留在背后触发按钮上）；
  取消按钮没有 `data-dialog-dismiss`，全局 Escape 的 `closeTopDialog` 点击容器只命中
  `stopPropagation`，焦点在框外时按 Esc 毫无反应。
- **改动**：`oc-session-panel.ts` 容器补 `tabindex="-1"`、取消按钮补
  `data-dialog-dismiss`（与其余 8 处弹窗同一契约）；新增
  `oc-session-panel-dialog.test.ts` 两条源码断言钉住该契约。
- **验证**：`npm run test:chat` 1134 pass / 0 fail（首次运行因新测试相对路径少一层
  `../` 失败，修正后全绿）；`npm run build` 通过（TEMP/TMP 隔离）。
- **遗留问题**：默认模型反馈耗时仍待探针网关打通；scripts 层 2 条沙箱既有失败。
- **下一轮候选**：排查其余自定义浮层是否同样脱离 dialog-a11y 契约；随后回到探针网关。

### 第 15 轮 · 2026-10-20

- **问题**：`app-toast.ts` 头注释仍写「显示 4 秒后自动消失」，与代码实际行为脱节——
  error 8s / warning 6s 早已存在，第 13 轮又新增「重复出现重置计时」，注释均未反映；
  排查其余候选（全部 `role="dialog"` 浮层、菜单 outside/Esc/focus 归还、图标按钮
  aria-label、toast 的 role/aria-live、setInterval 清理、模型列表空值守卫、setDefault
  反馈链）均确认已闭环，无可改缺陷。
- **改动**：仅更新 `app-toast.ts` 头注释，准确描述分档时长与重复重置行为（第 13 轮的
  注释收尾）。无运行时代码变化。
- **验证**：`npm run test:chat` 1134 pass / 0 fail；`npm run build` 通过（TEMP/TMP 隔离）。
- **遗留问题**：默认模型反馈耗时仍待探针网关打通（沙箱阻塞项）；gotchas.md 存在两个
  编号 140（重号），但修正需移动归档引用，收益低于成本，暂不处理；scripts 层 2 条
  沙箱既有失败。
- **下一轮候选**：重新尝试探针网关隔离方案（HOME/USERPROFILE/LOCALAPPDATA/锁目录），
  若仍阻塞则改扫主进程 `src/` 层的异步/错误处理缺陷。

### 第 16 轮 · 2026-10-20

- **问题**：IPC sender 校验（assertTrustedIpcSender）此前只靠模块级测试与评审纪律维持，
  没有全局契约——新增通道忘加校验不会触红任何测试（安全基线静默依赖人工）。
- **改动**：新增 `src/ipc-guard-coverage.test.ts`：静态扫描 src/ 全部
  `ipcMain.handle/on` 注册（窗口取到下一条注册或所在 register 函数收尾），断言每条
  通道直调 guard 或经本文件内含 guard 的 wrapper（如 git-ipc 的 guardGitOp）；
  含通道基数 >100 的防呆。纯测试新增，无运行时代码变化。
- **验证**：扫描确认现状 138 条通道全部已校验（0 漏）；阳性对照（换不存在的 guard 名）
  138/138 全部漏检，测试有牙。`npm run test:unit:node` 375 pass / 0 fail（含新增 1 条；
  首次运行因 `import.meta` 不被 CJS 产物接受而编译失败，改 `__dirname` 后通过）；
  Vitest 276 pass / 0 fail；`npm run build` 通过。
- **遗留问题**：同第 15 轮（探针网关沙箱阻塞、gotchas 重号、scripts 层 2 条沙箱失败）。
- **下一轮候选**：主进程 `src/` 层其余安全/健壮性契约补钉（如 preload 白名单一致性），
  或回到探针网关隔离方案。

### 第 17 轮 · 2026-10-20

- **问题**：`docs/ipc-api.md` 与 `src/preload.ts` 单向漂移——22 条已暴露的调用通道
  （memory:* ×9、webbridge 钉定刷新/扩展更新 ×3、skill-store 更新 ×2、plugin-store
  set-enabled/market-detail ×2、workspace 写/草稿/搜索 ×3、dialog:select-directory、
  file:thumbnail、theme:result）与 2 条事件通道（theme:request、settings:archive-progress）
  未写入这份自称「完整清单」的参考文档。（反向看似 23 条死通道仍在文档中，核查后确认
  均为有意保留的「已退役」注记，非漂移。）
- **改动**：仅 `docs/ipc-api.md`——按 preload 签名与 handler 实情补齐全部缺失条目
  （新增 Settings — Memory 小节；Advanced/CLI、技能商店、插件管理页、文件操作、
  工作空间、事件监听器六处各补行）。
- **验证**：复跑对齐探针：142 调用通道 + 9 事件通道 100% 有文档记录；
  `npm run test:chat` 1134 pass / 0 fail；`npm run build` 通过（TEMP/TMP 隔离）。
- **遗留问题**：同前（探针网关沙箱阻塞；gotchas 重号暂不处理；scripts 层 2 条沙箱失败）。
- **下一轮候选**：为 preload↔ipcMain 通道对齐加契约测试（需兼容模板/helper 注册形态），
  或回到探针网关隔离方案。

### 第 18 轮 · 2026-10-20

- **问题**：preload↔主进程通道对齐（第 17 轮修复的文档漂移只是症状）没有防回归契约——
  新增 preload 方法忘了注册 handler、或新增通道忘了写文档，都不会触红任何测试。
- **改动**：新增 `src/ipc-channel-contract.test.ts`，三条断言：① preload invoke/send
  每条通道主进程必有注册（兼容字面量、模板前缀——含「先赋 const 再注册」形态——与
  本文件 helper 调用点三种注册方式）；② preload 监听的每条事件通道主进程必有 `.send`
  来源；③ 全部通道必须出现在 `docs/ipc-api.md`（锁死第 17 轮对齐成果）。另修正
  `plugin-store.test.ts` 一处指向错误的覆盖注释（指向 ipc-guard-coverage.test.ts）。
- **验证**：node:test 376 pass / 0 fail（首次运行因模板通道「变量赋值后注册」形态
  漏解析而失败，补 `TEMPLATE_CHANNEL_CONST` 后通过——该失败同时充当未注册方向的
  阳性对照）；Vitest 276 pass / 0 fail；Chat UI 1134 pass / 0 fail；
  `npm run build` 通过。
- **遗留问题**：探针网关沙箱阻塞（默认模型耗时任由其阻塞）；gotchas 重号、scripts 层
  2 条沙箱失败（均既定不处理）。
- **下一轮候选**：探针网关隔离方案最后一试；若仍阻塞，本轮会话的静态可达优化面
  已基本收敛，考虑按「风险大于收益」收尾。

### 第 19 轮 · 2026-10-20（观察轮，无可改事项，循环收尾）

- **观察**：①探针网关重估——即便隔离解锁，「设为默认模型」测量还需真实登录账号
  配置 provider，沙箱内无法完成；其反馈链已在第 16 轮静态确认完整（即时提示 +
  spinner + 成功/失败 toast），残余价值低。②`app.ts` webbridgeRepairPollInterval
  实为 30s 常驻空转轮询、仅 pill 可见时做事——属有意设计（注释「消失即停」指零开销，
  非停表），非缺陷。③website/ 发布面与 2026.1019.0 完全一致（版本号、下载链、
  SHA-256、体积 261.7MB、日期）。④第 15–18 轮的系统排查（弹窗/菜单/焦点/a11y/
  计时器/IME/IPC guard 138 通道/preload↔main 对齐/文档对齐）均无现存缺陷。
- **决策（终止）**：剩余候选只剩沙箱阻塞项（探针网关、scripts 2 条失败）、用户明确
  回退项（消息悬浮操作行 24px）与既定不值得做项（gotchas 重号需动归档引用）。继续
  改下去只能制造无用户价值的 cosmetic churn——按终止条件「继续改动风险大于收益」
  收尾，本会话优化循环至此结束（第 13–19 轮，共 7 轮）。
- **改动**：无代码改动。
- **验证**：无需验证（观察轮）；回归基线保持：Chat UI 1134 / Vitest 276 /
  node:test 376 全 pass，`npm run build` 通过。
- **遗留问题（移交）**：默认模型耗时测量需正常桌面环境 + 登录账号；消息悬浮操作行
  24px 跳动维持原行为（用户决定）；scripts 层 2 条沙箱失败需在 CI/正常桌面复跑；
  gotchas.md 双 #140 重号留待下次整理归档时顺带处理。

### 第 20 轮 · 2026-10-20（工具调用展示/折叠深度优化，用户点名轮）

- **问题**：工具卡输出区 `.chat-tool-card__output` 是折叠体系中唯一不限高的内容区。
  长输出（>80 字符即走该区，渲染上限 8000 字符 ≈ 数百行代码）在展开的折叠组里可占
  数千像素，把线程后续内容全部推开；「共 N 行 / 查看完整输出」元信息出口被压到输出
  末尾，用户要翻完整段才能到达。同类区域全部限高——参数块 220px、JSON 折叠 400px、
  进度卡 40vh、实时思考 220px、本轮文件列表 240px——输出区是唯一离群者。
- **改动**（2 文件）：`chat-ui/ui/src/styles/chat.css` 输出区加 `max-height: 400px` +
  `overflow-y: auto` + `overscroll-behavior: contain`（400px 对齐 .chat-json-content；
  overscroll contain 对齐参数块，滚轮到底不外泄到消息线程）；
  `chat-ui/ui/src/ui/chat/tool-cards.test.ts` 既有输出区契约测试补三条钉定
  （限高/内滚/阻断滚动链）。元信息行是输出区的同级后继，限高后常驻卡内可视；
  流式进行中的卡本就不渲染输出区（既有设计），不受影响。
- **验证**：Chat UI 1134 pass / 0 fail（含 typecheck）；Vitest 276 pass / 0 fail；
  node:test 376 pass / 0 fail；`npm run build` 通过。
- **遗留问题**：卡内滚动区无底部渐隐暗示（规模信息已由元信息行承担，暂不加视觉糖）。
- **下一轮候选**：800px 最小窗宽下各设置 tab 与暗色模式截图复审，找真实视觉/交互缺陷。

### 第 21 轮 · 2026-10-20

- **观察**：复审 `out/ui-qa/2026-10-18T23-39/` 全套截图（800px 三视图、1440px 明暗、
  设置各 tab）。任务页运行记录里 `skill-collection-review-main` 的摘要把模型收尾消息
  的 markdown 语法原样露出（`## 技能处置 - **context-doc-tuning** — …`）——
  `views/tasks.ts::renderRunDetail` 对非失败行直接 `${detail}` 纯文本绑定。
  其余候选均被排除：设置-模型的「正在连接…」与「尚未连接账户」同帧是
  `auth.busy && !auth.sessionId` 的真实在途态（非缺陷）；扩展页 800px、远程控制暗色、
  对话页明暗均干净。
- **改动**（3 文件）：`controllers/tasks.ts` 新增纯函数 `runSummaryPreview`——
  剥标题/列表/引用行首记号、剔除分割线与围栏标记行（围栏内容保留）、行内代码/链接/
  图片/自动链接/加粗/斜体/删除线归纯文本、多行折叠单行；星号斜体要求紧贴内容
  （`a * b * c` 不误伤），下划线排除词内（snake_case 标识符不误伤，对齐 CommonMark
  词边界）；剥空回退折叠空白后的原文。失败行错误详情不走此函数（诊断逐字展示 +
  「展开详情」是完整原文语义）。`views/tasks.ts` 非失败行摘要改走该函数；
  `controllers/tasks.test.ts` 补 5 条钉定（截图形态还原/行内记号/围栏/纯文本与回退/
  紧贴规则）。
- **验证**：首跑 typecheck 失败（视图漏导入），补导入后复跑——Chat UI 1139 pass /
  0 fail（含 typecheck）；`npm run build` 通过。本轮改动不触 vitest/node:test 覆盖区
  （基线 276/376 沿用第 20 轮结果）。
- **遗留问题**：cron 详情面板的完整摘要（cron-manage.ts）保持原文直渲（完整展示语义，
  有意保留）；会话列表等其他预览位若日后出现同类裸语法，可复用 `runSummaryPreview`。
- **下一轮候选**：工作空间侧栏 worktree 路径断词（`openclaw/mild-\nbarnacle`）复查；
  对话页 composer 区域 800px 细审。

### 第 22 轮 · 2026-10-20

- **问题**：工作区左导航 compact worktree 卡的分支 chip 在 ~200px 侧栏里折成两行，
  且在连字符处断词（截图实证：`openclaw/mild-` / `barnacle`），胶囊形被撑破。
  分支名带斜杠/连字符是常态（feature/foo），凡是长分支名都会触发。
- **改动**（3 文件）：`views/worktrees.ts` compact 与标准两个变体的分支 chip
  改为 `chip wt-card__branch-chip` + 内层 `wt-card__branch` span（title 兜底完整名）；
  `styles/tasks-misc.css` 新增两条规则：chip 本体 inline-flex + min-width:0 +
  max-width:100%（flex 项可收缩），分支名单行省略；
  `workspace-ui.test.ts` 补源码 + CSS 钉定（两变体结构、限宽/收缩/省略/nowrap）。
- **验证**：Chat UI 1140 pass / 0 fail（含 typecheck）；`npm run build` 通过。
  本轮不触 vitest/node:test 覆盖区（基线 276/376 沿用第 20 轮结果）。
- **遗留问题**：chips 行内其余短 chip（所有者/状态）为固定文案，无需省略；
  worktree 全宽卡片的 `.wt-card__detail` 路径行本就是单行省略（无此问题）。
- **下一轮候选**：对话页 composer 在 800px 下的控件排布细审；会话列表超长标题与
  时间戳的窄窗表现。

### 第 23 轮 · 2026-10-20

- **问题**：file-changes 面板「在 git 中查看」链接（`.chat-git-view-link`）是无 href 的
  `<a>`，只有线程级 click 委托——没有 tabindex/role，键盘完全不可达，Enter/Space 也无
  委托分支。同区域同类元素（`.chat-path-link`、`.chat-subsession-link`、path-linker
  动态生成的路径链接）都已有 tabindex="0" role="button" + keydown 委托，它是唯一缺口。
  composer 工具栏 800px 细审无新问题（窄窗防线既有：flex-wrap + min-width:0 +
  模型选择器 max-width:180px）。
- **改动**（3 文件）：`chat/grouped-render.ts` git 链接补 `tabindex="0" role="button"`；
  `views/chat.ts` 线程 keydown 委托新增 git 分支（Enter/Space → onOpenGitView，位置在
  子会话引用之前，三个选择器互斥）；`workspace-ui.test.ts` 既有接线测试扩展键盘可达钉定
  （click 用 `closest(`、keydown 用 `closest?.(`，两条正则分别钉住两个分支）。
- **验证**：Chat UI 1140 pass / 0 fail（含 typecheck）；`npm run build` 通过。
  本轮不触 vitest/node:test 覆盖区（基线 276/376 沿用第 20 轮结果）。
- **遗留问题**：无（同渲染路径其余 `<a>` 已全量核对）。
- **下一轮候选**：暗色模式下 1440px 截图复审尚未覆盖的设置 tab（搜索/语音/备份恢复/
  高级/软件更新/MCP 与钩子）；会话列表项窄窗表现。

### 第 24 轮 · 2026-10-20

- **问题**：chat-ui 外链审计——`https://kimi.com/pricing?utm_source=oneclaw` 在
  `tab-provider.ts`（设置页 OAuth 无会员提示）与 `setup-step2-provider.ts`（安装向导
  同款提示）两处各自硬编码字面量，改链接需同步两处、易漂移。全量审计其余命中项：
  provider 预设 platformUrl/baseUrl 已集中在 `setup-constants.ts`（合理数据层）；
  渠道控制台/文档链接（tab-channels-* ×6、tab-search、setup-step2 文档链接）各仅单处
  使用，单点使用不构成缺陷，不强行为其建注册表（避免 cosmetic churn）。
- **改动**（4 文件）：`setup-constants.ts` 新增 `KIMI_PRICING_URL` 导出常量（紧邻
  SUB_PLATFORM_URLS）；两处视图改走共享常量；`setup-constants.test.ts` 新增回归锁——
  断言常量值不变 + 两处视图源码必须引用常量且不再含定价链接字面量。
- **验证**：Chat UI 1141 pass / 0 fail（含 typecheck）；`npm run build` 通过
  （TEMP/TMP 隔离）。本轮不触 vitest/node:test 覆盖区（基线 276/376 沿用第 20 轮结果）。
- **遗留问题**：审计附带发现 4 处 `oc-provider-link`/`oc-setup-link` 是无 href 锚点
  （tab-provider ×2、setup-step2 ×2），无 tabindex/role、键盘不可达——与第 23 轮
  git 链接同类缺陷，列入下轮候选。
- **下一轮候选**：4 处无 href 外链锚点补键盘可达性；随后回到暗色模式设置 tab 截图复审。

### 第 25 轮 · 2026-10-20

- **问题**：第 24 轮审计附带确认 5 处外链锚点（`tab-provider.ts` 的 2 个
  `oc-provider-link`、`setup-step2-provider.ts` 的 3 个 `oc-setup-link`）均无 href——
  不聚焦、不可 Tab 到达、Enter 无响应，与第 23 轮 git 链接同类缺陷；渠道 tab 的
  `oc-settings__link` 均有 `href="#"`（原生可达），这 5 处是全部缺口。
- **改动**（3 文件）：5 处锚点补真实 `href`（动态值绑 `target.platformUrl`/`platformUrl`/
  `KIMI_PRICING_URL`，文档链接用同值字面量），原生获得聚焦 + Enter 激活
  （走既有 @click 的 preventDefault + openExternal）+ 悬停可见目标地址；中键/新窗口由
  窗口层 `setWindowOpenHandler` deny 兜底，不会应用内导航。`setup-constants.test.ts`
  新增回归锁：两视图全部外链锚点必须含 `href=`。
- **验证**：Chat UI 1142 pass / 0 fail（含 typecheck）；`npm run build` 通过
  （TEMP/TMP 隔离）。不触 vitest/node:test 覆盖区（基线 276/376 沿用第 20 轮结果）。
- **遗留问题**：无（chat-ui 全部外链锚点已逐枚核对）。
- **下一轮候选**：暗色模式 1440px 下未复审的设置 tab（搜索/语音/备份恢复/高级/更新/
  MCP 与钩子）截图检查；或会话列表项窄窗表现。

### 第 26 轮 · 2026-10-20

- **问题**：UI QA 报告（`out/ui-qa/*/report.json`）的 textClipped 唯一残留项
  `H:.ts-stats__skeleton-chip«» (92>84 / 96>84)` 是检测器假阳性——横向裁切检查对
  **无可见文本**的元素也套用 scrollWidth>clientWidth 判定，而骨架 chip 的扫光 ::after
  做 translateX 动画（变换计入可滚动溢出区），中程采样必命中；历史上全部 textClipped
  记录（13-35 报告的 chat-loading 系列同样 «» 空文本）零真阳性。对照扫描
  （contrastScan）早已跳过空文本元素，溢出扫描缺同一条守卫。观察面同时排除了
  会话列表窄窗（label/chip 均已省略设防）、file-changes 路径链接、工具卡标题行
  （R85 已设防）、unsafeHTML 面（全部经 sanitize/escape）。
- **改动**（2 文件）：`scripts/lib/text-quality-scan.js` 在 H/V 判定前加
  `!(el.textContent || "").trim()` 跳过（含理由注释）；`scripts/ui-qa-libs.test.js`
  新增钉定：守卫存在且位于横向判定之前。运行时 UI 代码零改动。
- **验证**：真实 Chrome（headless）+ CDP 功能验证——还原页面含动画骨架 chip、静态
  溢出骨架、真裁切按钮：修复前表达式报全部三项（动画 chip 中程 121>84，机制实证），
  修复后只报真裁切按钮（225>56，真阳性保留）；`test:scripts` 177 pass / 0 fail
  （TEMP/TMP 隔离；未隔离时 5 条 esbuild/asar 失败为既有沙箱 ACL 类，与改动无关，
  隔离后全绿）；`test:unit:node` 376 pass / 0 fail；`npm run build` 通过。
  一次性验证脚本与还原页已删除。
- **遗留问题**：暗色模式设置 tab 截图复审仍需真实应用运行环境（Electron 在沙箱
  exit=3 无法启动，本轮已试过）；`--user-data-dir` 临时 Chrome profile 有残留风险，
  已用独立临时目录规避。
- **下一轮候选**：会话/工作区以外未静态复审的视图（扩展详情、cron 管理）过一遍
  已知缺陷类清单；或评估收尾（剩余候选多为环境阻塞项）。

### 第 27 轮 · 2026-10-20（收尾轮）

- **问题**：cron 管理视图任务列表项（`.cm-list__item`）是 `<div @click>`——无
  role/tabindex/keydown，键盘用户完全无法选中任务查看详情（主操作鼠标独占）。
  R69 的 a11y 契约（`activateOnKeydown`）注释列举的同类行/卡片（会话行、工作区树、
  git 文件行、worktree 卡）均已补齐，它是该契约的漏网者；内层编辑/删除按钮
  本就 stopPropagation + helper 的 target 守卫，不会重复触发。
- **改动**（2 文件）：`cron-manage.ts` 列表项补 `role="button" tabindex="0"` +
  `@keydown=${activateOnKeydown(...)}`（Enter/Space 触发选中，与 worktree compact 卡
  同形）；`tasks-view.test.ts` 在 renderListItem 函数域内钉定三要素。无 CSS 改动
  （无 outline 重置，浏览器默认焦点环；`:focus-within` 已能显内层按钮）。
- **验证**：Chat UI 1143 pass / 0 fail（含 typecheck）；`npm run build` 通过
  （TEMP/TMP 隔离）。不触 vitest/node:test 覆盖区（基线 276/376 沿用第 20 轮结果）。
- **遗留问题**：ext-detail.ts 本轮同批复审无同型缺陷（对话框 role/tabindex 俱全）；
  暗色模式设置 tab 截图复审与默认模型耗时测量仍受环境阻塞（Electron 沙箱 exit=3、
  探针网关），移交正常桌面/CI。
- **下一轮候选**：8 轮计划（第 20–27 轮）至此跑满，输出总结报告。

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
| 配置 | `src/cryoclaw-config.ts`、`openclaw-config-migration.ts`、Chat UI `controllers/config.ts`；写入走内核契约，数组删减须逐层声明 replacePaths |
| 草稿与文件 | `src/workspace-files.ts`、`workspace-ipc.ts`、Chat UI `controllers/workspace.ts`；备份、版本 hash、原子替换和根授权各有独立职责 |
| 会话与后台流 | Chat UI `app-session-actions.ts`、`session-transition.ts`、`run-state-store.ts`；异步续体必须检查会话/连接归属 |
| 设置与本地化 | Chat UI `views/settings/settings-view.ts`、`i18n/zh.ts`、`i18n/en.ts`；字典键集合由测试检查 |
| IPC | `src/preload.ts`、`ipc-sender-guard.ts`；以源码白名单和 sender guard 为准 |
| 打包、升级与发布 | `scripts/package-resources.js`、`afterPack.js`、`kernel-updater.ts`、`release-assert.js`；资源完整性、安装版和远端资产均须验证 |
| 清理 | `scripts/prune-artifacts.js`；只清理 `.cache`/`out` 的已知过期子项，不清用户数据、数据库备份或未知目录 |

## 后续变更的规则

- 对异步请求同时检查请求代次和所属连接/会话；有副作用的主进程调用还要保证执行顺序。
- 键盘确认入口要区分输入法组词：`isComposing` 或 `keyCode === 229` 时不得触发提交/保存。
- UI 采用设计 token、原生交互控件和中英对称字典；以 800px 最小窗宽检查布局和键盘操作。
- 新发现的非平凡问题要写入 [gotchas](../gotchas.md)，不再复制整段历史到当前交接页。
- 发布流程只有 [releasing.md](../releasing.md) 一份现行入口；正式版必须同时包含 exe、blockmap、latest.yml。
