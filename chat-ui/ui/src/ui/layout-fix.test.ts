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
