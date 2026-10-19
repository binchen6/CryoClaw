# 缓存与构建产物维护

先运行 `node scripts/prune-artifacts.js` 查看计划。默认只列出已知实验目录中超过 24 小时的内容，不直接删除。确认范围后运行 `node scripts/prune-artifacts.js --apply`；指定历史截止时间可加 `--before <ISO timestamp>`。

工具只接受仓库中的 `.cache`、`out` 子项。候选来自源码中的明确白名单与版本/截图保留规则，不从任意路径清单执行删除。每次操作重新检查绝对路径、真实路径和目录链接；禁止删除 `.cache`/`out` 根，禁止进入工作区外的链接。失败逐项记录，不能把残留当成功。

保留内容包括：当前及前一版本安装包、两个最新的带日期截图批次、Node/OfficeCLI/npm 下载缓存、数据库备份、用户状态和未知目录。`npm run clean` 是另一条全量重建清理命令，会删除当前构建输出，不用于日常过期内容维护。

执行报告：`.cache/maintenance-prune-report.json`。清理前应确认没有正在使用旧实验构建的应用进程。不要用清理脚本删除 `~/.openclaw`、`.dev-state` 或 `resources/targets`。
