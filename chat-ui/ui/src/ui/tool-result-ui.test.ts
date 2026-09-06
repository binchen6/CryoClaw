import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { zhDict } from "./i18n/zh.ts";
import { enDict } from "./i18n/en.ts";

/**
 * R52 T4 工具调用结果展现升级：源码接线审计。
 *
 * 锁定四条不变量（防后续重构静默断线）：
 * 1. markdown-sidebar.ts 挂载 chatTextEnhanceRef（sidebar 代码增强入口）；
 * 2. code-block-enhance.ts 的复制按钮文案走 i18n（不再硬编码中文）；
 * 3. tool-cards.ts 渲染复制按钮/diff 徽标/退出码徽标的 class 钩子存在；
 * 4. components.css 为 sidebar 代码增强与工具卡新元件提供样式；
 * 5. i18n zh/en 字典都包含新键（键集合一致性由 i18n.test.ts 兜底，这里查存在性）。
 */

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/，源文件位于 chat-ui/ui/src/
function readSource(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
}

test("R52T4 审计：markdown-sidebar 挂载 chatTextEnhanceRef 代码增强", () => {
  const source = readSource("views/markdown-sidebar.ts");
  assert.ok(source.includes("chatTextEnhanceRef"), "sidebar 未挂载 chatTextEnhanceRef");
  assert.ok(
    source.includes('from "../chat/code-block-enhance.ts"'),
    "sidebar 未从 code-block-enhance 导入 ref",
  );
});

test("R52T4 审计：code-block-enhance 复制按钮文案 i18n 化", () => {
  const source = readSource("chat/code-block-enhance.ts");
  assert.ok(source.includes('t("chat.codeCopy")'), "缺 chat.codeCopy");
  assert.ok(source.includes('t("chat.codeCopied")'), "缺 chat.codeCopied");
  assert.ok(source.includes('t("chat.codeCopyFailed")'), "缺 chat.codeCopyFailed");
  assert.ok(!source.includes('"复制代码"'), "仍存在硬编码中文复制文案");
});

test("R52T4 审计：tool-cards 渲染复制按钮/diff 徽标/退出码徽标钩子", () => {
  const source = readSource("chat/tool-cards.ts");
  assert.ok(source.includes("chat-tool-card__copy"), "缺复制按钮 class");
  assert.ok(source.includes("chat-tool-card__diff"), "缺 diff 徽标 class");
  assert.ok(source.includes("chat-tool-card__exit"), "缺退出码徽标 class");
  assert.ok(source.includes("resolveToolLanguage"), "未接语言推断");
  assert.ok(source.includes("resolveToolCardErrorText"), "未接错误摘要选择");
});

test("R52T4 审计：components.css 覆盖 sidebar 增强与工具卡新元件样式", () => {
  const source = readFileSync(new URL(`../../../../src/styles/components.css`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  for (const selector of [
    ".sidebar-markdown .chat-code-copy",
    ".sidebar-markdown .chat-code-lang",
    ".chat-tool-card__copy",
    ".chat-tool-card__diff-added",
    ".chat-tool-card__diff-removed",
    ".chat-tool-card__exit",
  ]) {
    assert.ok(source.includes(selector), `components.css 缺 ${selector}`);
  }
});

test("R52T4 审计：i18n zh/en 字典包含新键", () => {
  const keys = [
    "chat.toolCopyOutput",
    "chat.toolCopied",
    "chat.toolCopyFailed",
    "chat.toolDiffAria",
    "chat.toolExitCode",
    "chat.codeCopy",
    "chat.codeCopied",
    "chat.codeCopyFailed",
  ];
  for (const key of keys) {
    assert.ok(key in zhDict, `zh 缺 ${key}`);
    assert.ok(key in enDict, `en 缺 ${key}`);
  }
});
