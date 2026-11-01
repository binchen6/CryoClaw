import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const css = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../src/styles/chat.css"), "utf8");

test("message actions stay visible in a fixed compact row without hover layout shifts", () => {
  const rule = css.match(/\.chat-message-actions \{[^}]+\}/)?.[0] ?? "";
  assert.match(rule, /height: 26px/);
  assert.match(rule, /flex-wrap: nowrap/);
  assert.doesNotMatch(css, /\.chat-message-shell:is\(:hover,:focus-within\) \.chat-message-actions/);
  assert.match(css, /\.chat-message-actions :is\(\.chat-quote-btn,\.chat-copy-btn,\.chat-branch-btns\) \{ opacity: 1; pointer-events: auto; \}/);
  assert.match(css, /\.chat-message-actions :is\(\.chat-quote-btn,\.chat-copy-btn,\.chat-branch-btn\) \{[^}]+width: 24px;[^}]+height: 24px;/);
});
