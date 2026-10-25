# CryoClaw 最新版功能与实机演示

58 秒演示依次展示安装与模型、对话与文件、扩展、模板工作台和元素微调。组件示例与原速 Electron 录制分别标注；演示内容使用虚构任务、文件和看板数据，不调用模型生成修改。

## 交付物

- [演示视频](../website/assets/cryoclaw-demo.mp4)：1920 × 1080、30 fps、58 秒，H.264 / yuv420p、AAC 立体声，支持渐进播放。
- [封面](../website/assets/cryoclaw-demo-poster.jpg)、[中文字幕](../website/assets/cryoclaw-demo.zh-CN.vtt)。主标题和来源标识直接保留在画面中，静音时也能理解操作。
- [HyperFrames 源工程](../website/promo/latest/index.html)、[时间与字幕配置](../website/promo/latest/film.json)、[分镜](../website/promo/latest/storyboard.md)、[制作流程](../website/promo/latest/workflow.md)。工程内保留字体、许可、GSAP、组件截图、实机片段和本地合成配乐。
- [导出与验证脚本](../scripts/render-promo-latest.cjs)、[原速录制转换器](../scripts/import-promo-screencast.cjs)。历史 20 秒源工程仍保留在 `website/promo/` 上一级，当前官网播放的成片由 `latest/` 导出。

## 分镜与来源

| 时间 | 内容 | 来源与边界 |
|---|---|---|
| 0–2 秒 | 安装即有运行环境，连接自己的模型 | 品牌标题；不显示未经实测的启动或安装耗时。 |
| 2–6 秒 | 模型设置与新增模型入口 | 当前 Electron 设置页，隔离 QA 配置。 |
| 6–12 秒 | 对话、文件卡片与继续输入 | 当前 Electron 对话页；消息为明确标注的演示数据，附件是实际本地文件。 |
| 12–18 秒 | 工作区文件编辑与保存 | 当前 Electron 工作区，真实本地演示文件与保存接口。 |
| 18–23 秒 | 本机技能与插件管理 | 当前 Electron 验收实例录制，原速；不宣称实时市场规模。 |
| 23–32 秒 | 模板菜单、交互预览、尺寸切换与添加 | 当前 Electron 录制，原速。 |
| 32–38 秒 | 右键标签，编辑标题与用途说明 | 当前 Electron 录制，原速。 |
| 38–45 秒 | 晶体鼠标响应、展开行程页面、退出全屏 | 当前 Electron 录制，原速，保留同一个运行文档。 |
| 45–55 秒 | 统一铅笔入口、选中元素、填写要求、退出编辑 | 当前 Electron 录制，原速；不调用模型，不补造生成结果。 |
| 55–58 秒 | 品牌与下载引导 | 内置运行环境，连接自己的模型，AGPL-3.0 开源。 |

影片使用柔和交叉淡化连接场景，不给实机录制添加合成鼠标。片段首尾取舍与拼接属于剪辑；任务耗时没有可比性。配乐在本机合成，没有第三方音乐样本或外部生成服务。

## 功能依据

| 能力 | 当前代码 | 文案范围 |
|---|---|---|
| 内置运行环境 | `scripts/package-resources.js`、`src/setup-ipc.ts` | 无需另装开发环境，仍需连接模型账户。 |
| 模型管理与备用链 | `chat-ui/ui/src/ui/views/settings/tab-provider.ts`、`chat-ui/ui/src/ui/controllers/models.ts` | 模型与思考档位取决于服务商。 |
| 浏览器与 Office | `src/webbridge.ts`、`builtin-skills/officecli-docx/`、`officecli-xlsx/`、`officecli-pptx/` | 浏览器需要扩展与授权；文件卡为示例，不暗示本次实际交付。 |
| 文件与 Git 工作区 | `chat-ui/ui/src/ui/views/workspace.ts`、`git.ts`、`controllers/workspace.ts` | 文本编辑、预览与草稿保护；不暗示内嵌 Office 可视化编辑器。 |
| 技能与插件 | `src/skill-store.ts`、`src/plugin-store.ts` | 展示本机已安装内容；按来源安装与配置。 |
| 模板与页面管理 | `builtin-plugins/cryoclaw-dashboards/templates.mjs`、`chat-ui/ui/src/ui/components/oc-dashboard.ts` | 使用随应用提供的模板和演示数据。 |
| 元素定位与微调入口 | `builtin-plugins/cryoclaw-dashboards/inspector.mjs`、`chat-ui/ui/src/ui/views/dashboard-compose.ts` | 展示选择和填写要求；生成需要用户连接并调用模型。 |

## 重新制作与核验

完整命令见[制作流程](../website/promo/latest/workflow.md)。工具安装在 `.cache/hyperframes-tools/`，不更改应用依赖和锁文件。本次由 `node scripts/capture-dashboard-demo.cjs --out .cache/promo-final-2` 生成原始 JPEG、动作记录、时间戳和 ffconcat；过期原始帧由维护流程清理，导入后的源片段保留在 `website/promo/latest/media/`。片段旁的 `.provenance.json` 保存源清单 SHA-256、帧数、剪辑区间和 `speed: 1`。最终成片为 58 秒、13,164,960 B，SHA-256 `33b8e3854a8828c623ab6a2e48c302008ef1641a2e62f2a8d4126e7b428367d1`。

```powershell
node scripts/prepare-promo-latest.cjs
python scripts/subset-promo-font.py --font-library 'C:/Users/binchen/Desktop/code/font'
node scripts/render-promo-latest.cjs

# 对已有成片重做封面、接触图和实际 MP4 播放检查。
node scripts/render-promo-latest.cjs --check-only
```

导出器先检查片段来源、长度与工程时序，再运行 HyperFrames lint、validate 和 inspect。导出后以 FFprobe 检查编码、画幅、时长、音轨和 MP4 元数据位置，并在浏览器中实际播放、逐场景跳转。`.cache/promo-latest/` 留存检查 JSON、逐场景静帧、源工程接触图和实际 MP4 播放接触图。

官网保持按需加载视频，用户点击后开始播放。部署时同步 MP4、封面和字幕，保持 `website/` 的相对路径。源工程预览请使用 HyperFrames Studio 启动时显示的 `http://localhost:<port>/#project/latest`；`index.html` 是源代码。
