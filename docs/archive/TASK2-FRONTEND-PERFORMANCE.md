# Task 2：前端性能修复与证据

## 范围与边界

- 只改看板组件及独立样式、聊天历史注水 controller、Markdown 缓存和对应定向测试。
- 不改全局样式、聊天 composer、设置 UI；不运行全量测试、不重建共享应用产物、不提交/发布、不覆盖真实安装。
- 既有懒路由、首屏请求优先级、900px/900ms 看板预热已经存在，不将它们记作本次新增优化。
- 本次修复不宣称消除了真实应用冷启动瓶颈。历史文档中的网关插件加载耗时不等同于本次前端修复收益。

## 根因与实现

### 1. 看板滚动热路径

[oc-dashboard.ts](../../chat-ui/ui/src/ui/components/oc-dashboard.ts)：

- 原 visibility 通知顺带发送 inspector 状态，每次可见性变化都读取主题计算样式。现在只有 frame load、编辑状态/选择变化更新 inspector；未编辑时也不再读取 accent。
- 原每条 iframe 消息先扫描全部 iframe 再匹配来源（包括 wheel）。现在用观察到的 contentWindow → iframe WeakMap 查询，仍检查 DOM 连接及 observedFrames 成员关系；断开组件时重置索引，reload 时重新登记。
- 保留 iframe sandbox、不接受未知来源、原先一帧合并 wheel、卡片懒挂载、预热节流、展开/恢复文档连续性。
- [dashboard.css](../../chat-ui/ui/src/styles/dashboard.css) 只将顶部标签条的 18px backdrop blur 换成不透明背景 token。模态/展开层样式未动；继续使用 scroll-behavior:auto，避免程序式滚动追赶。

### 2. 首次聊天历史加载中断

[chat.ts](../../chat-ui/ui/src/ui/controllers/chat.ts)：原 loadChatHistory 在 RPC 前就取消现有注水 timer。首次 80 条历史先显示20条时，后续慢刷新/失败刷新可让剩余历史永远不展示。

现在只在实际替换快照前取消旧 timer。定向回归使用假计时器验证：首批20 → 慢刷新等待32ms仍增至60 → 刷新失败后再32ms增至80。保留原有并发代次、会话/客户端/run 身份和短旧快照保留规则；没有合并独立的并发 RPC。

这修复“首聊剩余历史不继续加载”，不是网络首字节或模型首次响应提速。

### 3. 可量化 Markdown 缓存保留量

[markdown.ts](../../chat-ui/ui/src/ui/markdown.ts)：原仅限制200项、每份输入≤50k字符；HTML转义膨胀后可累计约60M code units。新增源文本+HTML合计2,000,000 code units预算，与200项限制共同执行LRU驱逐。流式 bypass、不缓存超长输入及命中提升顺序保持不变。

markdownCacheStats 暴露条目/保留 code units/预算以供测试观测。code units 是字符串成本，不是浏览器 heap 字节。

## 定向验证

验证时使用临时隔离配置，输出到 `chat-ui/ui/.task2-test-dist`，未使用共享测试输出。已按lead要求清除临时配置及生成目录；保留日志。若需独立复现，在协调编译后临时创建 `chat-ui/tsconfig.task2-test.json`：

```json
{
  "extends": "./tsconfig.test.json",
  "compilerOptions": { "outDir": "./ui/.task2-test-dist" },
  "include": [
    "ui/src/ui/markdown.test.ts", "ui/src/ui/controllers/chat.test.ts",
    "ui/src/ui/components/oc-dashboard-perf.test.ts", "ui/src/ui/dashboard-motion.test.ts",
    "ui/src/ui/dashboard-model.test.ts", "ui/src/ui/dashboard-selection.test.ts",
    "ui/src/ui/page-preload.test.ts"
  ]
}
```

```bash
node node_modules/typescript/bin/tsc -p chat-ui/tsconfig.task2-test.json
node --test chat-ui/ui/.task2-test-dist/ui/src/ui/markdown.test.js \
  chat-ui/ui/.task2-test-dist/ui/src/ui/controllers/chat.test.js \
  chat-ui/ui/.task2-test-dist/ui/src/ui/components/oc-dashboard-perf.test.js \
  chat-ui/ui/.task2-test-dist/ui/src/ui/dashboard-motion.test.js \
  chat-ui/ui/.task2-test-dist/ui/src/ui/dashboard-model.test.js \
  chat-ui/ui/.task2-test-dist/ui/src/ui/dashboard-selection.test.js \
  chat-ui/ui/.task2-test-dist/ui/src/ui/page-preload.test.js
```

输出目录须含 `package.json` 的 `{"type":"module"}`（仓库既有测试脚本采用相同 ESM 方式）。

- 修复前红灯：首次注水冻结、超额缓存、看板热路径/blur断言均触发。[红灯日志](../../.cache/task2-red-tests.log)。
- 修复后：隔离编译成功；7个定向文件 **64 tests / 64 pass / 0 fail**，最终一次488.55ms。[最终日志](../../.cache/task2-final-tests.log)。controller 文件内部手动执行的多组断言在 Node runner 中计作1项。
- 看板 VM 测试执行真实类方法（仅移除 import/decorator，Lit/DOM stub），100条 visibility 无 inspector/style读取；12条wheel合成1 rAF，scroll100→340；未知、分离、未观察来源不生效。额外 source audit 防止热路径回退。它们不是渲染器FPS测试。

## 独立 V8 堆内存测量

可重跑 [profile-frontend-memory.mjs](../../scripts/profile-frontend-memory.mjs)：自动只编译Markdown及其依赖到独占临时目录，结束自动清理；无需保留上述测试配置。每种模式独立运行进程。baseline 从 `git show HEAD:chat-ui/ui/src/ui/markdown.ts` 读取原实现，不覆盖源代码或应用产物；HEAD包含修复后需显式传入修复前git ref。

```bash
node --expose-gc scripts/profile-frontend-memory.mjs baseline
node --expose-gc scripts/profile-frontend-memory.mjs current
```

Node v24.14.0；相同200份约50k字符、包含大量 `&` 的压力输入；前后各强制GC三次。DOMPurify 使用与Node Markdown测试相同的无DOM stub；fixture走超40k的escape fallback。每种模式独立运行三次。

| 指标 | 原实现 | 修复后 |
|---|---:|---:|
| 保留条目 | 200 | 6 |
| 保留源+HTML code units | 59,995,380 | 1,799,868 |
| heapUsed增量，第1次 | 60,047,336 B | 1,833,632 B |
| heapUsed增量，第2次 | 60,049,384 B | 1,833,632 B |
| heapUsed增量，第3次 | 60,049,832 B | 1,833,632 B |

该压力夹具的缓存字符串保留量降低97.0%，第一组强制GC后heap增量降低96.95%。不是整个Electron进程、渲染器RSS或正常短消息的内存降幅。

原始JSON：[baseline 1](../../.cache/task2-memory-baseline.json)、[2](../../.cache/task2-memory-baseline-2.json)、[3](../../.cache/task2-memory-baseline-3.json)；[current 1](../../.cache/task2-memory-current.json)、[2](../../.cache/task2-memory-current-2.json)、[3](../../.cache/task2-memory-current-3.json)。

## 真实组件离线 CDP 冒烟

[dashboard-perf-cdp-smoke.js](../../scripts/dashboard-perf-cdp-smoke.js) 复用隔离profile、拒绝http/https/ws/wss的 [reference fixture](../../scripts/lib/reference-ui-fixture.cjs) 和 [CDP harness](../../scripts/lib/cdp-harness.js)，专用port9353。使用lead构建的dist、自定义元素真实oc-dashboard、24个本地srcdoc和生产iframe runtime。state保存只进入fixture内存；不创建真实board、不读用户profile、不发模型请求。

```bash
node scripts/dashboard-perf-cdp-smoke.js --port 9353 --out .cache/task2-dashboard-cdp
```

最终一次验证：[report.json](../../.cache/task2-dashboard-cdp-final/report.json)，`ok:true`、`targetVerified:true`、无renderer exception。启动前断言端口空闲，随机CRYOCLAW_REFERENCE_MARKER匹配URL后才允许connect/evaluate，拒绝误连既有实例。

- 24个真实iframe均进入观察集合且来源索引匹配；未知来源消息拒绝。state roundtrip `{note:"offline only",count:3}` 通过。
- iframe内部原生wheel：嵌套容器scrollTop 0→120，看板仍0，不抢子区域滚动。
- 12×20透传wheel通过生产runtime使看板到240；随后原生wheel往返240→840→240。
- steady-state 11条wheel消息、10条visibility通知，dashboard主题style读取 **0**、iframe全量扫描 **0**、inspector消息 **0**；顶部tabs计算样式backdrop-filter为none。
- 297个rAF间隔样本：p50 **4.2ms**、p95 **10.0ms**、最大 **10.1ms**，>50ms **0**。这是合成24frame场景，不是线上全页FPS基准，未测修复前后FPS差值。
- [顶部截图](../../.cache/task2-dashboard-cdp-final/dashboard-top.png)、[滚动截图](../../.cache/task2-dashboard-cdp-final/dashboard-scrolled.png) 均人工检查无卡片变形。

夹具显式让24frame全部挂载，排除lazy mount冷启动；srcdoc需要测试专用CDP CSP bypass（在导航前设置），产品CSP未变，网络拒绝/iframe sandbox仍启用。初始控制台仅记录预期被拒的ws:0连接尝试；测量阶段无异常。上述结果仅证明真实组件边界和steady-state wheel路径，不代表全应用启动、正常业务看板FPS或Electron RSS。
