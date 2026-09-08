// 守护回归（源码审计，2026.9 提案 A 重写版）：
// 旧模型（各 fullpage 视图根容器 padding-top: var(--titlebar-h) 自行让位）已废弃——
// 标题栏改为主列内 44px 占位块（shell.css .cryoclaw-titlebar），视图内容从其下缘
// 开始，视图自身再做让位 = 双重留白回归。本文件钉住新契约。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

function css(rel: string): string {
  const raw = readFileSync(new URL(`../../../../src/styles/${rel}`, import.meta.url), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, ""); // 剥注释：防块内注释干扰规则捕获
}

test("tokens-ext：--titlebar-h 布局 token 存在（44px）", () => {
  assert.match(css("tokens-ext.css"), /--titlebar-h:\s*44px/, "缺标题栏让位 token");
});

test("shell.css：标题栏为主列内 44px 占位块（高度走 token + drag 区）", () => {
  const shell = css("shell.css");
  const titlebar = shell.match(/\.cryoclaw-titlebar\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(titlebar, /height:\s*var\(--titlebar-h\)/, "titlebar 高度应走 token");
  assert.match(titlebar, /-webkit-app-region:\s*drag/, "titlebar 应为 drag 区");
  assert.match(titlebar, /flex-shrink:\s*0/, "titlebar 不应被压缩");
});

test("视图 CSS 不得自带标题栏让位（壳层统一占位）", () => {
  const files = readdirSync(new URL("../../../../src/styles", import.meta.url)).filter((f) =>
    f.endsWith(".css"),
  );
  for (const file of files) {
    if (file === "shell.css" || file === "tokens-ext.css") continue;
    assert.doesNotMatch(
      css(file),
      /padding-top:\s*(?:calc\()?var\(--titlebar-h\)/,
      `${file} 不得用 --titlebar-h 做顶部让位（旧 fullpage 让位模型已废弃）`,
    );
  }
});

test("design-tokens：--ext-column / --chat-column 阅读列宽 token 存在", () => {
  const dt = readFileSync(new URL("../../../../../../shared/design-tokens.css", import.meta.url), "utf8");
  assert.match(dt, /--ext-column:\s*\d+px/, "缺扩展视图内容列宽 token");
  assert.match(dt, /--chat-column:\s*\d+px/, "缺聊天阅读列宽 token");
});

// R58b：线程尾部内联卡（子代理等待卡）必须与历史消息共用 --chat-column 居中列，
// 否则卡片撑满整个 .chat-thread 容器，视觉上与上下消息未对齐（同 R58a progress-card 回归）
test("chat.css：子代理等待卡容器走居中阅读列（--chat-column）", () => {
  const chat = css("chat.css");
  const container = chat.match(/\.chat-subagent-cards\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(container, "缺 .chat-subagent-cards 规则");
  assert.match(container, /max-width:\s*var\(--chat-column\)/, "容器应限宽 --chat-column");
  assert.match(container, /margin[^;]*\bauto\b/, "容器应水平居中（margin auto）");
  assert.match(container, /width:\s*100%/, "容器应占满列宽");

  const card = chat.match(/\.chat-subagent-card\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(card, "缺 .chat-subagent-card 规则");
  assert.doesNotMatch(card, /max-width/, "卡片不应自带限宽（与 tool 卡一致撑满阅读列）");
});

// R61b：回底按钮悬浮于消息流内部底缘（上负 margin 提入 thread），不得压在 compose 顶缘上
// （旧 margin: 0 auto -52px 实测按钮与 compose 顶重叠 12px 遮挡输入区上沿）
test("panels.css：回底按钮悬浮于消息流内部底缘（不遮挡 compose）", () => {
  const panels = css("panels.css");
  const btn = panels.match(/\.chat-new-messages\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(btn, "缺 .chat-new-messages 规则");
  assert.match(btn, /margin:\s*-44px\s+auto\s+-8px/, "上 -44px 提入 thread、下 -8px 消占位（总负占位不变）");
  assert.match(btn, /align-self:\s*center/, "保持水平居中");
  assert.match(btn, /z-index:\s*10/, "悬浮层高于消息内容");
});

