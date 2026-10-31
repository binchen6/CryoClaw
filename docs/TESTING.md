# 测试与验收

`npm test` 始终运行四层全量回归：Vitest、主进程 node:test、Chat UI 全源类型检查与测试、构建和发布脚本。
默认最多并发三层；低内存设备可执行 `node scripts/run-tests.js --serial`，或用 `CRYOCLAW_TEST_CONCURRENCY=1|2` 显式降级。每层日志和耗时汇总写入 `.cache/test-results/`。
任何一层失败都使整体失败，超时会停止对应进程树。定向入口 `test:unit:vitest`、`test:unit:node`、`test:chat`、`test:typecheck`、`test:scripts` 保留。

Chat UI 测试编译包含全部源代码，合并两次 TypeScript 遍历；单独 `test:typecheck` 仍可只查类型。
每次编译先清理测试输出，防止已删除用例残留。Vitest 与 node:test 按完整相对路径区分归属，不能按同名文件过滤。
脚本测试动态发现 js/mjs，`package-resources.test.js` 的 VM 夹具单独运行，本地与 CI 使用同一入口。

有打包资源时执行真实 ASAR 网关测试。就绪、失败、超时均停止进程树再清理状态目录，只允许明确的首次迁移重启重试。
端口算法由受控事件验证，HTTP 集成使用 OS 分配端口，不能假设相邻端口可用。

UI 门禁等待转场、控件与数据加载结束。600ms 是操作间隔下限，不是页面就绪证明。
新手引导采用隔离状态目录验收，不覆盖用户已配置的账户和工作区。
执行 `node scripts/setup-ui-smoke.js`：真实 Electron 渲染构建 UI，使用独立 profile 与合成 IPC；外网、真实安装/卸载和账户写入均禁用。覆盖模型验证失败/重试、控件忙碌状态、配置快照、首次启动失败/重试以及 800×600/1440×900 明暗截图。
