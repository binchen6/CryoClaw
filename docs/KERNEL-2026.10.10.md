# OpenClaw 2026.10.10 升级审查

本次升级采用官方 npm 2026.10.10，六个官方 Feishu、Moonshot、Kimi、Zai、Qwen、DeepSeek 插件同步到同版。独立 Node 保持 24.22.1，满足上游 `>=24.16.0 <25 || >=26.1.0`。稳定通道钉定同步，兼容下限仍为 2026.7.0。未发布的 2026.1103.0 候选由 2026.1104.0 接替。

## 来源与契约

- [官方版本说明](https://github.com/openclaw/openclaw/releases/tag/v2026.10.10)。npm tarball SHA512：`9HZhzq/Yck3uH3M/iYP7szqoF5JXpXfz0+orhBOKalSH+dj0IC9uWPECkR1vH4lMCytxpHjJKHh9efXRYMJl6w==`，与下载字节及冻结锁一致。
- RPC 515→529，事件61→62，没有删除原有表面；新增14个方法与 `agent.identity.changed`。这只证明接口集合兼容，不替代实际消息、动态插件及 UI 验收。
- Agent 数据库准入从25升到27：源码同时要求旧库迁移和拒绝大于27的库，不把只读上限误当迁移下限。`doctor --fix` 保留上游 recovery backup 的快照覆盖、完整性及物理身份检查。已有应用的迁移入口继续遵循此机制，不直接改写 schema 或绕过租约。
- 共享状态库支持版本22；旧测试将21当未来版的夹具已改为999，继续验证未知新格式拒绝。新增身份变化事件复用现有身份加载器，仅刷新匹配的当前Agent，并防止旧连接的迟到结果覆盖重连后状态。
- 迁移前本机独立一致性备份位于忽略目录 `out/startup-artifacts/pre-kernel-2026.10.10/`，包含配置、state20和agent25，SQLite完整性均为ok；不提交个人数据。

## 补丁清理

| 原补丁 | 10.10处理与理由 |
|---|---|
| Agent publication retry | 退役；上游4次有界 typed cancellation 重试、删除准入保留，禁止嵌套旧重试 |
| Plugin copy batch lifetime | 退役；上游使用 operation-owned copy/open batch 的 using 清理 |
| Small source revalidation | 退役；上游 source custody、内容哈希及有序 receipt 接管 |
| Usage context overlap | 退役；上游对选中页面按 budget 读取并复用 hydration |
| Lazy Control UI retention | 退役；上游 worker pool、LRU、root generation、abort及pending join接管 |
| Windows idle broker exit | 退役；上游operation-owned shutdown等待launches、childStops及resources.close后排空进程组，旧轮询捷径不再适用 |
| Windows canonical paths | 适配新的 openFile 参数；仍保留真实路径、bigint身份、硬链接及大小准入 |
| Webhook completion precheck | 适配上游缓存的同一 completion authority；明确false和原迁移路径保留 |
| Command catalog cache | 10.10退役；旧内部导出和配置指纹合同已变化，改走原生作用域/技能命令构建。重用已有资源时仅清理可精确识别的旧注入。仅已验证10.7/10.9保留旧缓存，增加请求作用域身份键及过期scope检查；其余版本保留原生路径 |
| TypeBox offline layout | 固定1.3.35的703个运行模块SHA256及9个公开入口，合并为17文件；共享类型、registry及验证行为对照通过；1.3.34仍受支持，未知版不变换 |
| Bundled dependency repair | 新版不再内置的Undici副本不重建；普通Zod依赖走精确安全覆盖，旧版bundle保留原修复 |

退役不是忽略零命中：对新版先检查具体上游 ownership/budget 合同，缺失或残留旧marker时构建失败。旧内核继续走原适配。物理目录模式不启用历史ASAR身份例外。

## 实际运行暴露的问题

初步候选完成数据库迁移及首次可用（448860ms，其中Doctor约373s），身份/历史/会话均成功、无renderer异常；首次升级不能等同常规启动。原生备份已在agent和state数据库旁生成 `pre-startup-migration-*.bak`，另有本轮独立一致性备份。

随后固定工作负载的 `commands.list` 报错，暴露旧缓存仍绑定旧 `agent-scope-config` 别名；不能将这次失败报告当作合格基线。已退役该缓存，增加真实捆绑Node链接命令模块的集成检查，避免只看字符串命中数。

退出诊断进一步定位到新的原生缓存策略：10.10前台主线程不启用编译缓存，工作线程继续启用；旧应用却提前启用了主线程缓存，触发上游再次spawn一个Gateway。桌面父IPC持有启动器，资源采样也只看到启动器。已按上游已核对的handoff协议直接进入前台进程，Windows参数同步原生8192栈设置，不改内核源码或关闭工作线程缓存。真实Node协议验证已通过，最终安装验证待完成。

保留原SIGTERM语义；试验中的SIGINT选择没有解决进程归属问题，已撤回。接受停止后对应用自己的父IPC执行unref，避免它单独保活已清理的Node进程，保持所有原生清理句柄和预算。真实IPC子进程异步清理后自然退出的回归已加入。

性能门禁新增端口所属PID必须等于应用直接持有的网关、独立Node路径匹配、网关exit0且没有强杀保底。应用exit0不再足够。原wrapper试验的CPU/内存数字无效，旧报告的ok只代表旧门禁，不能用于最终性能结论。

## 验证状态

真实上游包两轮物理补丁幂等验证通过，五项源码替代、idle broker和命令缓存合计七处退役均验证其替代契约。TypeBox1.3.35真实703文件指纹和合并前后行为通过。最终来源构建与覆盖安装通过，数据库迁移已完成；后续启动及发布门禁以[发布验收](RELEASE-2026.1104.0-VERIFICATION.md)为准。
