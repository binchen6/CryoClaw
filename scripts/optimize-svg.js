// 用 svgo 原地优化 chat-ui/ui/src/assets/cryoclaw-favicon.svg（multipass，保持视觉不变）。
// svgo 安装在 chat-ui/ui（devDependency），这里用 createRequire 从该目录解析。
"use strict";
const { readFileSync, writeFileSync } = require("fs");
const { join, resolve } = require("path");
const { createRequire } = require("module");

const root = resolve(__dirname, "..");
const uiRequire = createRequire(join(root, "chat-ui", "ui", "package.json"));
const { optimize } = uiRequire("svgo");

const target = join(root, "chat-ui", "ui", "src", "assets", "cryoclaw-favicon.svg");

const input = readFileSync(target, "utf8");
const result = optimize(input, {
  path: target,
  multipass: true,
  // preset-default（svgo v4 起 removeViewBox 已从预设中移除，默认保留 viewBox，favicon 可缩放）
});

writeFileSync(target, result.data, "utf8");
console.log(
  `[optimize-svg] ${target}: ${input.length} -> ${result.data.length} bytes`,
);
