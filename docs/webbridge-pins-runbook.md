# WebBridge 钉定清单轮转手册（webbridge-pins runbook）

> 适用范围：`resources/webbridge-pins.json`（远端钉定清单）、`src/webbridge.ts`
> 内嵌钉定表 `WEBBRIDGE_BINARY_SHA256_PINS`、`src/webbridge-pins.ts` 加载/缓存逻辑。

## 背景：为什么需要轮转

上游把 `https://kimi-web-img.moonshot.cn/webbridge/latest/releases/<name>` 当作
**可反复重建的发布位**——实测同一文件多次重建后字节数不变、仅 Go build ID 等
约 177 字节元数据变化（2026-09-10 一天内发生两次）。CryoClaw 对下载产物执行
exact-sha256 fail-closed 校验，上游每次原地重建都会让「修复 WebBridge」/「立即
更新」报 `PIN_STALE`（UI 文案「WebBridge 组件校验未通过（上游已更新）」）。

T8 之后钉定清单是**多哈希 schema v2**：`pins[filename]` 为字符串数组（v1 单串
仍兼容读取），保留最近 5 代产物哈希，任意一枚命中即通过。校验语义不变——仍是
精确 sha256 比对，不匹配即删除落盘产物并抛错（fail closed）。

## 信任模型（已接受风险，2026-10-04 决策）

- **信任锚 = 本仓库 main 分支的写权限**（经 HTTPS）。清单不加独立签名：能改写
  repo main 的攻击者同样能改 App 源码与发布资产，签名不增加实际攻击成本。
- 拉取通道仅 https；禁止 https→http 重定向降级；清单体积 ≤64KB、超时 10s、
  重定向 ≤3 次；JSON 结构严格校验（64-hex，逐项），任一非法条目 → 整份清单丢弃。
- 校验链：内嵌表 ∪ 远端清单（多哈希），全部不命中 → fail closed。内嵌表是离线
  兜底快照，权威值在 repo main 的清单文件。
- **逃生门**：`KIMI_WEBBRIDGE_SKIP_PIN=1` 跳过校验（仅排障；会让未校验产物
  落盘执行，日常禁用）。
- 应用内缓存：`~/.kimi-webbridge/remote-pins.json`，默认 24h 新鲜期；
  「刷新钉定」按钮 / 更新管线走 force 路径绕过缓存。

## 自动轮转（首选，无需人工）

`.github/workflows/refresh-webbridge-pins.yml`：

- 触发：`workflow_dispatch`（手动）+ release published。
- 动作：跑 `scripts/refresh-webbridge-pins.mjs` → 有变化时把
  `resources/webbridge-pins.json` 直接提交回 main（`GITHUB_TOKEN`，
  `contents: write`；无变化跳过提交）。

上游重建 latest 后用户报 PIN_STALE 时，**第一时间去 Actions 页手动 run 一次
workflow_dispatch**，然后让用户点应用内「刷新钉定」。

## 手动轮转（本地）

```bash
node scripts/refresh-webbridge-pins.mjs --dry-run   # 预览将发生的变更
node scripts/refresh-webbridge-pins.mjs             # 写回 resources/webbridge-pins.json
```

脚本行为：下载每个被钉定文件名的 latest 产物 → 计算 sha256 → 前插进对应数组
（去重、保留最近 5 枚）→ bump `version: 2` 与 `updatedAt`。任一文件下载失败则
整体失败（不写半份清单）。改完提交并推送 main。

## 应用内「刷新钉定」（用户侧自救）

设置 → 高级 → WebBridge：

- 「立即更新」/修复流程命中 PIN_STALE 后，版本卡片与修复 modal 会出现
  「刷新钉定」按钮；
- 点击后走 IPC `webbridge:refresh-pins`：force 拉取远端清单（绕 24h 缓存）、
  写回本地缓存，成功后自动重试刚才失败的更新/修复流程。

## jsDelivr 缓存滞后

默认 URL 顺序是 jsDelivr（国内可达性好）→ raw.githubusercontent。jsDelivr 的
CDN 缓存有小时级滞后，刚推送的新清单可能拉不到。因此 **force 刷新路径
（`loadRemotePins({ force: true })`）自动把 raw.githubusercontent.com 排到
jsDelivr 前面**；非 force 路径维持 jsDelivr 优先。排查「刷新了还是旧清单」时
先确认这一点，必要时用 `CRYOCLAW_WEBBRIDGE_PINS_URL`（仅 https）临时指定源。

## 发版时同步内嵌表（可选）

内嵌表 `WEBBRIDGE_BINARY_SHA256_PINS`（`src/webbridge.ts`）只是离线兜底。发版
前把清单中每个文件名的**最新一枚**哈希抄进内嵌表，可让全新安装（远端清单不可
达时）也有较新的基线；不抄也不阻塞发版——修复路径会自动拉远端清单。

## 故障排查速查

| 症状 | 处置 |
|---|---|
| 用户报「校验未通过（上游已更新）」 | 手动 run workflow_dispatch → 让用户点「刷新钉定」 |
| 「刷新钉定」失败（网络不可达） | 检查 jsDelivr/raw 可达性；必要时 `CRYOCLAW_WEBBRIDGE_PINS_URL` 指定镜像 |
| 清单格式非法被整体丢弃 | 校验 `resources/webbridge-pins.json`：值必须 64-hex 字符串或数组（≤5 枚） |
| 排障需临时放行 | `KIMI_WEBBRIDGE_SKIP_PIN=1` 启动 App（用毕即撤） |
| CI workflow 提交失败 | 确认 fork/分支保护；`permissions: contents: write` 是否被组织策略覆盖 |
