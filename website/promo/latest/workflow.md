# 重新制作官网演示片

这个 HyperFrames 项目为 58 秒、1920 × 1080、30 fps。主工程保持离线字体、GSAP、软件截图与录制片段完整；安装工具只写仓库 `.cache/`，不更改应用依赖或锁文件。

## 工具

```powershell
npm install --prefix .cache/hyperframes-tools hyperframes@0.8.195 gsap@3.15.0 @ffprobe-installer/win32-x64 --no-audit --no-fund
```

需要现有 FFmpeg（libx264 / AAC / MP3）和 Chromium。`scripts/render-promo-latest.cjs` 支持 `--ffmpeg`、`--ffprobe`、`--browser`、`--render-browser` 指定路径；Playwright 可以通过 `CRYOCLAW_PLAYWRIGHT_PATH` 指向包含该包的 `node_modules`。Windows 默认查找 Playwright 的 `chrome-headless-shell.exe`，其版本探测可直接退出；常规 `chrome.exe --version` 在 Windows 上可能超时。正式编码禁用该机自检失败的 drawElement 快速捕获，使用截图捕获。

HyperFrames 调用设置 `DO_NOT_TRACK=1` 和 `HYPERFRAMES_NO_TELEMETRY=1`。此工程不使用模型、云端渲染、TTS、外部音乐素材或用户生产数据。

## 更新素材

```powershell
node scripts/prepare-promo-latest.cjs
python scripts/subset-promo-font.py --font-library 'C:/Users/binchen/Desktop/code/font'
```

字体子集需要 `fonttools` 和 `brotli`。`prepare-promo-latest.cjs` 同步官网 token、许可文件、图标与明确标注的组件示例截图。若页面组件改动，需要在重新捕获组件截图后再同步。

实机片段从隔离的真实 Electron 验收实例取得。使用 `Page.startScreencast` 的 JPEG、原始时间戳和 ffconcat 文件。转换器保持时间戳，只裁指定的首尾，输出 30 fps，不改速：

```powershell
node scripts/import-promo-screencast.cjs --input .cache/promo-final-2/templates/frames.ffconcat --output website/promo/latest/media/templates.mp4 --start 0 --duration 9
```

模板菜单、标题说明、全屏、元素微调与本机扩展管理分别使用 `media/templates.mp4`、`details.mp4`、`fullscreen.mp4`、`microadjust.mp4`、`extensions.mp4`。录制目录名 `microadjust` 对应工程的 `microadjust.mp4`，`workspace` 对应 `workspace.mp4`。每段视频旁的 `.provenance.json` 记录原始 ffconcat 校验值、原始帧数、剪辑区间与 `speed: 1`。保留每段开头约 1 秒静帧，让淡化与内容进入完成后再出现关键动作。

`film.json` 保存章节、场景、预览采样与字幕。改变片长时同步 `index.html` 的媒体 `data-start` / `data-duration` 和 `promo.js` 的同步时间轴；导出器会校验三者是否一致。录制转换不改变速度，场景长度须与裁剪后的实际片段一致。

## 导出与核验

```powershell
# 缺少实机素材时只检查已就绪的示例静帧，不写官网资产。
node scripts/render-promo-latest.cjs --draft-stills --browser 'C:/path/to/chrome.exe'

# 检查全部素材；合成本地配乐与字幕；lint、validate、inspect 后导出。
node scripts/render-promo-latest.cjs --browser 'C:/path/to/chrome.exe'

# 对现有 MP4 重做封面、接触图与实际浏览器播放检查。
node scripts/render-promo-latest.cjs --check-only --browser 'C:/path/to/chrome.exe'
```

成片写入 `website/assets/cryoclaw-demo.mp4`，封面写入 `cryoclaw-demo-poster.jpg`，字幕写入 `cryoclaw-demo.zh-CN.vtt`。`.cache/promo-latest/` 保留 `recordings.json`、`ffprobe.json`、`verification.json`、源片 `contact-sheet.jpg` 和实际成片 `playback-contact-sheet.jpg`，以及逐场景静帧。交付前应实看接触图及元素定位、全屏、扩展三个实际播放画面。

本工程的 `index.html` 是源代码。HyperFrames Studio 的项目预览入口是启动 preview 后显示的 `http://localhost:<port>/#project/latest`。
