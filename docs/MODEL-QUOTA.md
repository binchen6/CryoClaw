# 模型额度与余额

聊天输入框右侧的小圆条显示当前模型可查询的剩余额度。点击查看套餐、各周期额度、重置时间和同步时间；金额余额显示货币标记，不会被换算成虚构的剩余百分比。

## 查询来源

| 提供商 | 数据来源 | 显示内容 |
|---|---|---|
| ChatGPT / Codex | OpenClaw 原生 `usage.status`，需要完成账户登录 | 套餐、5 小时及每周窗口，以服务实际返回为准 |
| Claude、Copilot、Gemini CLI 等原生账户 | OpenClaw 原生 `usage.status` | 仅显示内核在当前凭据下返回的窗口；普通 API Key 不等于订阅登录 |
| Kimi Code | 原生额度或现有 Kimi 订阅查询 | 周额度、短周期用量 |
| Moonshot | 官方余额接口 | 可用余额、赠送余额 |
| DeepSeek | 官方余额接口 | 可用余额、赠送与充值余额 |
| 硅基流动 SiliconFlow | 官方 `/v1/user/info` | 账户总余额与充值余额；币种未返回时不猜测 |
| OpenRouter | 官方 `/api/v1/key` | 密钥金额上限、有效预算、免费模型每日请求额度 |
| MiniMax | 原生额度或官方订阅剩余额度接口 | 按模型展示 5 小时及每周窗口，需要订阅密钥 |
| 智谱 / Z.ai Coding | 原生额度或现有套餐监控查询 | 服务返回的用量与重置时间 |

自定义名称的提供商也可通过官方 Base URL 识别 OpenRouter、硅基流动、MiniMax、Moonshot 和 DeepSeek。第三方转发地址不会被自动当作官方地址。

OpenRouter 显示的是当前密钥限制，不能据此推算账户总余额。未设置密钥金额上限时会明确提示；免费请求窗口只影响以 `:free` 结尾的模型。账户余额可在其控制台查看，无需为此提供额外管理密钥。

MiniMax 的 `current_interval_usage_count` 和 `current_weekly_usage_count` 表示剩余次数。按剩余值计算用量，避免方向颠倒；按量付费密钥未返回订阅数据时显示查询失败。

## 刷新与异常

- 对话页每 60 秒尝试刷新，隐藏窗口不发起定时查询；输入和同一提供商内切换模型不会重复请求。模型设置页也复用同一份缓存。
- 多个原生提供商共享一次正在进行的 `usage.status` 请求。内核返回正在刷新或过期快照时，短暂等待后再读取，次数有上限。
- 临时失败会保留上次成功的值及原始同步时间，并提示数据未更新。更换连接或完成账户登录会隔离或清除旧缓存。
- 没有接口、凭据不适用或缺少字段时显示未知，不显示 0% 或“无限额度”。多个适用窗口取最紧的一项作为圆条比例。
- API Key 仅由主进程读取并发送到查询接口，渲染层只接收归一化用量和余额。

## 接口依据与验收边界

- [OpenRouter 当前密钥](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)
- [SiliconFlow 官方 OpenAPI](https://github.com/siliconflow-inc/siliconflow-api/blob/main/openapi.yaml)
- [MiniMax 订阅 FAQ](https://platform.minimax.io/docs/m-plan/faq)

解析与缓存回归覆盖错误响应、空字段、零额度、金额精度、MiniMax 剩余语义、免费模型隔离、并发合并和临时失败缓存。新增供应商没有使用用户真实密钥逐一联网验收；真实账户验证与接口契约测试分别记录，不能互相替代。


额度未知时，输入框圆环以较小的淡色虚线和圆点显示，保留原点击区域；悬浮、键盘聚焦或展开详情时恢复可见性。提示明确写“额度未知”，不使用 0% 或空余额冒充未知。已知百分比、已知余额（包括实际为零）保持正常显示。
