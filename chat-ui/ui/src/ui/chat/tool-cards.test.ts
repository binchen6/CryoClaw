import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";

// 渲染路径会经 markdown/DOMPurify（node 无 DOM 时走透传）。与 grouped-render.test.ts
// 同法：导入前打桩最小 window/customElements，让 DOMPurify 以 isSupported=false
// 初始化（sanitize 原样返回），工具卡模板结构即可在纯 node 下断言。
const nodeGlobals = globalThis as Record<string, unknown>;
nodeGlobals.customElements ??= {
  define() {},
  get() {
    return undefined;
  },
};
nodeGlobals.window ??= {
  document: { nodeType: 9, currentScript: null, createElement: () => ({}) },
  Element: class {},
};

const {
  extractSpawnSessionRef,
  extractToolCards,
  formatToolArgsJson,
  isNestedToolCardControl,
  renderToolCardSidebar,
} = await import("./tool-cards.ts");

// ── sessions_spawn 子会话引用提取 ──

test("spawn ref：accepted 结果 details.childSessionKey 解析成功", () => {
  const ref = extractSpawnSessionRef({
    kind: "result",
    name: "sessions_spawn",
    text: JSON.stringify({
      status: "accepted",
      details: {
        status: "accepted",
        runId: "run-1",
        childSessionKey: "agent:main:sub:abc",
        label: "调研子任务",
        sessionUrl: "https://example.invalid/s/abc",
      },
    }),
  });
  assert.deepEqual(ref, {
    sessionKey: "agent:main:sub:abc",
    label: "调研子任务",
    sessionUrl: "https://example.invalid/s/abc",
  });
});

test("spawn ref：details 缺省时兜底顶层字段；无 label/sessionUrl 可省略", () => {
  const ref = extractSpawnSessionRef({
    kind: "result",
    name: "sessions_spawn",
    text: JSON.stringify({ childSessionKey: "agent:main:sub:xyz" }),
  });
  assert.deepEqual(ref, { sessionKey: "agent:main:sub:xyz", label: undefined, sessionUrl: undefined });
});

test("spawn ref：非 sessions_spawn 工具 / 非 JSON / 缺 childSessionKey 均返回 null", () => {
  assert.equal(
    extractSpawnSessionRef({ kind: "result", name: "read", text: '{"childSessionKey":"x"}' }),
    null,
  );
  assert.equal(
    extractSpawnSessionRef({ kind: "result", name: "sessions_spawn", text: "not json" }),
    null,
  );
  assert.equal(
    extractSpawnSessionRef({ kind: "result", name: "sessions_spawn", text: '{"status":"ok"}' }),
    null,
  );
  assert.equal(
    extractSpawnSessionRef({ kind: "result", name: "sessions_spawn" }),
    null,
  );
});


// ── extractToolCards：三态（pending / error）归并 ──

test("tool cards：流式 call 消息带 pending → call 卡标记进行中", () => {
  // 与 app-tool-stream.ts::buildToolCallMessage 同构
  const msg = {
    role: "assistant",
    pending: true,
    content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
  };
  const cards = extractToolCards(msg);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "call");
  assert.equal(cards[0].pending, true);
  assert.equal(cards[0].error, undefined);
});

test("tool cards：历史 call 消息无 pending 字段 → 不标进行中", () => {
  const msg = {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }],
  };
  const cards = extractToolCards(msg);
  assert.equal(cards[0].pending, undefined);
});

test("tool cards：消息级 isError=true（流式 resultMessage）→ result 卡带 error", () => {
  // 与 app-tool-stream.ts::buildToolResultMessage 同构
  const msg = {
    role: "toolResult",
    toolCallId: "tc1",
    isError: true,
    content: [{ type: "text", text: "command failed: exit 1" }],
  };
  const cards = extractToolCards(msg);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "result");
  assert.equal(cards[0].error, "command failed: exit 1");
});

test("tool cards：消息级无 isError → result 卡无 error", () => {
  const msg = {
    role: "toolResult",
    toolCallId: "tc1",
    content: [{ type: "text", text: "ok" }],
  };
  const cards = extractToolCards(msg);
  assert.equal(cards[0].error, undefined);
});

test("tool cards：toolResult block 级 isError=true → error（历史形态）", () => {
  const msg = {
    role: "tool",
    content: [{ type: "toolResult", name: "exec", text: "boom", isError: true }],
  };
  const cards = extractToolCards(msg);
  assert.equal(cards[0].kind, "result");
  assert.equal(cards[0].error, "boom");
});

test("tool cards：isError 非严格 true（字符串/0）宽容忽略", () => {
  const msg = {
    role: "tool",
    content: [{ type: "toolResult", name: "exec", text: "ok", isError: "true" }],
  };
  assert.equal(extractToolCards(msg)[0].error, undefined);
  const msg2 = {
    role: "toolResult",
    toolCallId: "tc1",
    isError: 0,
    content: [{ type: "text", text: "ok" }],
  };
  assert.equal(extractToolCards(msg2)[0].error, undefined);
});

// ── R52 T4：diffStat / errorSummary / exitCode / toolArgs 提取 ──

test("tool cards：call 内容块带 diffStat（input_delta 实时/终态最终）→ 卡带 diffStat", () => {
  // 与 app-tool-stream.ts::buildToolCallMessage 同构
  const msg = {
    role: "assistant",
    pending: true,
    content: [
      {
        type: "toolCall",
        id: "tc1",
        name: "write",
        arguments: { path: "a.ts" },
        diffStat: { added: 3, removed: 1 },
      },
    ],
  };
  const cards = extractToolCards(msg);
  assert.deepEqual(cards[0].diffStat, { added: 3, removed: 1 });
});

test("tool cards：call 内容块 diffStat 非法载荷宽容忽略", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "tc1", name: "write", arguments: {}, diffStat: { added: -1 } },
    ],
  };
  assert.equal(extractToolCards(msg)[0].diffStat, undefined);
});

test("tool cards：流式 resultMessage 消息级 toolErrorSummary/exitCode/diffStat/toolArgs 提取", () => {
  // 与 app-tool-stream.ts::buildToolResultMessage 同构
  const msg = {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "exec",
    toolArgs: { command: "npm test" },
    isError: true,
    toolErrorSummary: "command failed: exit 2",
    exitCode: 2,
    diffStat: { added: 0, removed: 4 },
    content: [{ type: "text", text: "raw output…" }],
  };
  const cards = extractToolCards(msg);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "result");
  assert.equal(cards[0].error, "raw output…");
  assert.equal(cards[0].errorSummary, "command failed: exit 2");
  assert.equal(cards[0].exitCode, 2);
  assert.deepEqual(cards[0].diffStat, { added: 0, removed: 4 });
  assert.deepEqual(cards[0].args, { command: "npm test" });
});

test("tool cards：消息级字段缺失/非法时卡不携带对应字段", () => {
  const msg = {
    role: "toolResult",
    toolCallId: "tc1",
    toolErrorSummary: "   ",
    exitCode: 1.5,
    diffStat: "nope",
    content: [{ type: "text", text: "ok" }],
  };
  const card = extractToolCards(msg)[0];
  assert.equal(card.errorSummary, undefined);
  assert.equal(card.exitCode, undefined);
  assert.equal(card.diffStat, undefined);
  assert.equal(card.args, undefined);
});

test("tool cards：历史 toolResult block 级 toolErrorSummary/exitCode 宽容读取", () => {
  const msg = {
    role: "tool",
    content: [
      {
        type: "toolResult",
        name: "exec",
        text: "boom",
        isError: true,
        toolErrorSummary: "exit 1",
        exitCode: 1,
      },
    ],
  };
  const card = extractToolCards(msg)[0];
  assert.equal(card.errorSummary, "exit 1");
  assert.equal(card.exitCode, 1);
});

// ── R83：合并卡提取（call 块自带 result 载荷）──

test("tool cards（R83）：call 块带输出 → 单张卡同时携带输入与输出", () => {
  // 与 app-tool-stream.ts::buildToolCallMessage result 后形态同构
  const msg = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "tc1",
        name: "exec",
        arguments: { command: "npm test" },
        text: "all passed",
        exitCode: 0,
      },
    ],
  };
  const cards = extractToolCards(msg);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "call");
  assert.equal(cards[0].pending, undefined);
  assert.equal(cards[0].text, "all passed");
  assert.equal(cards[0].error, undefined);
  assert.equal(cards[0].exitCode, 0);
  assert.deepEqual(cards[0].args, { command: "npm test" });
});

test("tool cards（R83）：call 块带 isError → 卡带 error + errorSummary", () => {
  const msg = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "tc1",
        name: "exec",
        arguments: { command: "npm test" },
        text: "boom",
        isError: true,
        toolErrorSummary: "exit 2",
        exitCode: 2,
      },
    ],
  };
  const card = extractToolCards(msg)[0];
  assert.equal(card.error, "boom");
  assert.equal(card.errorSummary, "exit 2");
  assert.equal(card.exitCode, 2);
});

test("tool cards（R83）：call 块空字符串输出 → 完成态（text 空串）", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" }, text: "" },
    ],
  };
  const card = extractToolCards(msg)[0];
  assert.equal(card.pending, undefined);
  assert.equal(card.text, "");
  assert.equal(card.error, undefined);
});

// ── R84 工具卡详情：输入参数 pretty-print / 截断 / 结构 ──

test("args JSON 字符串：合法 JSON 对象先 parse 再 pretty-print（2 空格）", () => {
  // 截图回归形态：单行紧凑 JSON 撑破卡片 → 展开为多行
  const formatted = formatToolArgsJson(
    '{"status":"completed","replaySafe":false,"telemetry":{"catalogSize":75}}',
  );
  assert.equal(
    formatted,
    '{\n  "status": "completed",\n  "replaySafe": false,\n  "telemetry": {\n    "catalogSize": 75\n  }\n}',
  );
});

test("args JSON 字符串：数组同样 pretty-print；标量/非 JSON 字符串原样保留", () => {
  assert.equal(formatToolArgsJson('["a","b"]'), '[\n  "a",\n  "b"\n]');
  assert.equal(formatToolArgsJson("npm test -- --grep tool"), "npm test -- --grep tool");
  assert.equal(formatToolArgsJson("C:\\Users\\a\\b.ts"), "C:\\Users\\a\\b.ts");
  assert.equal(formatToolArgsJson('{"broken":  '), '{"broken":');
  assert.equal(formatToolArgsJson('"quoted"'), '"quoted"');
});

test("args 对象/nil：对象 pretty-print，空对象与 null/undefined 返回 null", () => {
  assert.equal(formatToolArgsJson({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(formatToolArgsJson({}), null);
  assert.equal(formatToolArgsJson(null), null);
  assert.equal(formatToolArgsJson(undefined), null);
  assert.equal(formatToolArgsJson("   "), null);
});

test("args 超长紧凑 JSON：截断上限内且保留 pretty-print 换行", () => {
  const payload = JSON.stringify({
    items: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `item-${i}` })),
  });
  assert.ok(payload.length > 4000, "构造条件：紧凑 JSON 应超过 4000 字符");
  const formatted = formatToolArgsJson(payload);
  assert.ok(formatted, "超长 JSON 仍应返回内容");
  assert.ok(formatted.length <= 4001, `截断长度应 ≤ 4001，实际 ${formatted.length}`);
  assert.ok(formatted.endsWith("…"), "截断以 … 结尾");
  assert.ok(formatted.includes("\n  "), "截断后仍保留 pretty-print 缩进换行");
});

test("tool cards：call 块 arguments 为 JSON 字符串时先 parse（渲染层再 pretty-print）", () => {
  const msg = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "tc1",
        name: "status",
        arguments: '{"status":"completed","catalogSize":75}',
      },
    ],
  };
  const card = extractToolCards(msg)[0];
  assert.deepEqual(card.args, { status: "completed", catalogSize: 75 });
});

// TemplateResult 递归遍历（无 DOM，直接检查 lit 模板结构）——与 grouped-render.test.ts 同法
type Collected = { strings: string[]; values: unknown[] };

function collectTemplates(value: unknown, acc: Collected): void {
  if (value === null || value === undefined || typeof value === "boolean") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTemplates(item, acc);
    }
    return;
  }
  if (typeof value === "object") {
    if ("_$litDirective$" in value) {
      const directive = value as { values?: unknown[] };
      if (Array.isArray(directive.values)) {
        collectTemplates(directive.values, acc);
      }
      return;
    }
    const maybe = value as { strings?: string[]; values?: unknown[] };
    if (Array.isArray(maybe.strings) && Array.isArray(maybe.values)) {
      acc.strings.push(...maybe.strings);
      collectTemplates(maybe.values, acc);
    }
    return;
  }
  acc.values.push(value);
}

function collect(value: unknown): Collected {
  const acc: Collected = { strings: [], values: [] };
  collectTemplates(value, acc);
  return acc;
}

test("renderToolCardSidebar：detail 行超长文本进 title（省略显示不丢全文）", () => {
  const longPath =
    "C:\\Users\\binchen\\Desktop\\code\\Oneclaw2\\Oneclaw\\chat-ui\\ui\\src\\ui\\chat\\a-very-long-file-name-for-tool-card.ts";
  const args = { path: longPath, limit: 200 };
  const expectedDetail = formatToolDetail(resolveToolDisplay({ name: "read", args }));
  assert.ok(expectedDetail, "构造条件：read 卡应有 detail");
  const result = collect(
    renderToolCardSidebar({ kind: "call", name: "read", args, text: "ok" }),
  );
  const strings = result.strings.join("");
  assert.ok(strings.includes("chat-tool-card__detail"), "缺 detail 行容器");
  assert.ok(strings.includes("chat-tool-card__label"), "工具名应有可省略的 label 容器");
  // title 属性值 + 文本内容各一次：完整路径不因省略而丢失
  assert.ok(
    result.values.filter((value) => value === expectedDetail).length >= 2,
    "detail 文本与 title 应各出现一次",
  );
});

test("renderToolCardSidebar：紧凑 JSON 字符串参数以多行展开渲染", () => {
  const compact = '{"status":"completed","replaySafe":false,"telemetry":{"catalogSize":75}}';
  const result = collect(
    renderToolCardSidebar({
      kind: "call",
      name: "status",
      args: { payload: compact, verbose: true },
      text: "ok",
    }),
  );
  const strings = result.strings.join("");
  assert.ok(strings.includes("chat-tool-card__args"), "缺输入参数折叠容器");
  assert.ok(strings.includes("chat-tool-card__args-body"), "缺参数正文容器");
  const pretty = formatToolArgsJson({ payload: compact, verbose: true })!;
  assert.ok(result.values.includes(pretty), "参数正文应绑定 pretty-print 后的多行文本");
  assert.ok(pretty.includes("\n  "), "pretty-print 应含缩进换行");
});

test("renderToolCardSidebar：长输出走卡内输出区块，超 20 行出现规模元信息行", () => {
  const text = Array.from({ length: 30 }, (_, i) => `output line ${i}`).join("\n");
  const result = collect(
    renderToolCardSidebar({ kind: "call", name: "exec", args: { command: "ls" }, text }),
  );
  const strings = result.strings.join("");
  assert.ok(strings.includes("chat-tool-card__output"), "缺卡内输出区块");
  assert.ok(strings.includes("chat-tool-card__output-meta"), "缺输出规模元信息行");
  assert.ok(!strings.includes("chat-tool-card__more"), "未截断时不应出现「查看完整输出」入口");
});

test("renderToolCardSidebar：超长输出截断并给出「查看完整输出」入口", () => {
  const text = "x".repeat(9_000);
  const result = collect(
    renderToolCardSidebar({ kind: "call", name: "exec", args: { command: "cat big.log" }, text }),
  );
  const strings = result.strings.join("");
  assert.ok(strings.includes("chat-tool-card__more"), "截断时应出现「查看完整输出」入口");
});

// ── CSS 结构审计：横向溢出防线的可自动化部分 ──

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/chat/，五级回到 chat-ui/ui 根再进 src/styles
function styleSource(file: string): string {
  const raw = readFileSync(new URL(`../../../../../src/styles/${file}`, import.meta.url), "utf8");
  return raw.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 选择器按逗号分组（忽略 :where()/() 内的逗号） */
function splitSelectors(selectorText: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of selectorText) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out.filter(Boolean);
}

/** 选择器精确匹配的规则声明块 */
function cssRule(css: string, selector: string): string {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    if (splitSelectors(m[1]).includes(selector)) {
      return m[2];
    }
  }
  return "";
}

/** 从标记文本后第一个 { 到配对 } 的声明块（用于含逗号的 :where 分组选择器） */
function cssBlockAfter(css: string, marker: string): string {
  const at = css.indexOf(marker);
  if (at < 0) {
    return "";
  }
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return open < 0 || close < 0 ? "" : css.slice(open + 1, close);
}

test("chat.css：工具卡容器与网格子项 min-width:0 + max-width:100%", () => {
  const css = styleSource("chat.css");
  const card = cssRule(css, ".chat-tool-card");
  assert.ok(card, "缺 .chat-tool-card 规则");
  assert.match(card, /min-width:\s*0/);
  assert.match(card, /max-width:\s*100%/);

  const gridRuleAt = css.indexOf(".chat-tool-card > :where(");
  assert.ok(gridRuleAt >= 0, "缺工具卡网格子项防溢出分组规则");
  const gridOpen = css.indexOf("{", gridRuleAt);
  const gridClose = css.indexOf("}", gridOpen);
  const gridSelectors = css.slice(gridRuleAt, gridOpen);
  const gridChildren = css.slice(gridOpen + 1, gridClose);
  for (const child of [
    "__header",
    "__title",
    "__meta",
    "__detail",
    "__args",
    "__output",
    "__status-text",
    "__subsession",
    "__inline",
  ]) {
    assert.ok(gridSelectors.includes(`.chat-tool-card${child}`), `分组规则缺 ${child}`);
  }
  assert.match(gridChildren, /min-width:\s*0/);
  assert.match(gridChildren, /max-width:\s*100%/);
});

test("chat.css：参数块/内联输出保留换行并允许任意断点", () => {
  const css = styleSource("chat.css");
  const argsBody = cssRule(css, ".chat-tool-card__args-body");
  assert.ok(argsBody, "缺 .chat-tool-card__args-body 规则");
  assert.match(argsBody, /white-space:\s*pre-wrap/);
  assert.match(argsBody, /overflow-wrap:\s*anywhere/);
  assert.match(argsBody, /max-width:\s*100%/);

  const inline = cssRule(css, ".chat-tool-card__inline");
  assert.ok(inline, "缺 .chat-tool-card__inline 规则");
  assert.match(inline, /overflow-wrap:\s*anywhere/);
  assert.match(inline, /max-width:\s*100%/);

  const statusText = cssRule(css, ".chat-tool-card__status-text");
  assert.match(statusText, /overflow-wrap:\s*anywhere/);
});

test("chat.css：输出区与围栏代码块宽度受限、块内横向滚动", () => {
  const css = styleSource("chat.css");
  const output = cssRule(css, ".chat-tool-card__output");
  assert.ok(output, "缺 .chat-tool-card__output 规则");
  assert.match(output, /min-width:\s*0/);
  assert.match(output, /max-width:\s*100%/);

  const pre = cssRule(css, ".chat-tool-card__output pre");
  assert.ok(pre, "缺 .chat-tool-card__output pre 规则");
  assert.match(pre, /max-width:\s*100%/);
  assert.match(pre, /overflow-x:\s*auto/);

  const meta = cssRule(css, ".chat-tool-card__output-meta");
  assert.match(meta, /flex-wrap:\s*wrap/, "元信息行空间不足时应换行而非挤压");
  const metaText = cssRule(css, ".chat-tool-card__output-meta > span");
  assert.match(metaText, /white-space:\s*nowrap/);
  assert.match(metaText, /flex-shrink:\s*0/);
});

test("chat.css：detail 行超长省略，参数 summary 箭头与文字对齐", () => {
  const css = styleSource("chat.css");
  const detail = cssRule(css, ".chat-tool-card__detail");
  assert.match(detail, /overflow:\s*hidden/);
  assert.match(detail, /text-overflow:\s*ellipsis/);
  assert.match(detail, /white-space:\s*nowrap/);

  const summary = cssRule(css, ".chat-tool-card__args summary");
  assert.match(summary, /align-items:\s*center/);
  assert.match(summary, /gap:\s*var\(--spacer-4\)/, "箭头与文案应走 gap 对齐（不再用箭头 margin）");
  const summaryArrow = cssRule(css, ".chat-tool-card__args summary::before");
  assert.match(summaryArrow, /line-height:\s*1/);
  assert.match(summaryArrow, /flex-shrink:\s*0/);
});

test("chat.css：折叠组/消息级输出 body 同样防溢出，摘要省略规则完整", () => {
  const css = styleSource("chat.css");
  for (const selector of [".chat-tools-collapse__body", ".chat-tool-msg-body", ".chat-tool-subgroup__body"]) {
    const block = cssRule(css, selector);
    assert.ok(block, `缺 ${selector} 规则`);
    assert.match(block, /min-width:\s*0/, `${selector} 应 min-width:0`);
    assert.match(block, /max-width:\s*100%/, `${selector} 应 max-width:100%`);
  }
  const collapseContainers = cssBlockAfter(css, ".chat-tools-collapse,\n.chat-tool-subgroup,");
  assert.ok(collapseContainers, "缺折叠容器防溢出规则");
  assert.match(collapseContainers, /min-width:\s*0/);
  assert.match(collapseContainers, /max-width:\s*100%/);

  for (const selector of [
    ".chat-tools-summary__names",
    ".chat-tools-summary__detail",
    ".chat-tool-subgroup__detail",
    ".chat-tool-msg-summary__names",
    ".chat-tool-msg-summary__preview",
    ".chat-subsession-link > span",
  ]) {
    const block = cssRule(css, selector);
    assert.ok(block, `缺省略规则 ${selector}`);
    assert.match(block, /text-overflow:\s*ellipsis/, `${selector} 缺省略号`);
    assert.match(block, /white-space:\s*nowrap/, `${selector} 应单行省略`);
    assert.match(block, /min-width:\s*0/, `${selector} 应 min-width:0`);
  }
});

test("chat.css / components.css：新增工具卡规则不硬编码色值（主题安全）", () => {
  const colorLiteral = /#[0-9a-fA-F]{3,8}\b/;
  const chat = styleSource("chat.css");
  const blocks = [
    cssRule(chat, ".chat-tool-card"),
    cssRule(chat, ".chat-tool-card__args-body"),
    cssRule(chat, ".chat-tool-card__output"),
    cssRule(chat, ".chat-tool-card__detail"),
    cssRule(chat, ".chat-tool-card__output-meta"),
    cssRule(chat, ".chat-tool-card__status-text"),
    cssRule(chat, ".chat-tool-card__inline"),
  ];
  for (const block of blocks) {
    assert.doesNotMatch(block, colorLiteral, "工具卡规则不得硬编码 hex");
  }
  const components = styleSource("components.css");
  for (const selector of [".chat-tool-card__meta", ".chat-tool-card__diff", ".chat-tool-card__exit", ".chat-tool-card__copy"]) {
    const block = cssRule(components, selector);
    assert.ok(block, `components.css 缺 ${selector}`);
    assert.match(block, /flex-shrink:\s*0/, `${selector} 不应被标题挤压`);
    assert.doesNotMatch(block, colorLiteral, `${selector} 不得硬编码 hex`);
  }
});

// ── 交互契约：参数/输出区内的操作不得冒泡打开整卡 sidebar（CDP 复测 bug） ──

function toolCardsSource(): string {
  const raw = readFileSync(
    new URL("../../../../../src/ui/chat/tool-cards.ts", import.meta.url),
    "utf8",
  );
  return raw.replace(/\r\n/g, "\n");
}

test("tool-cards 源码：参数折叠 details 自吞 click/keydown（展开不再冒泡打开 sidebar）", () => {
  const source = toolCardsSource();
  const argsAt = source.indexOf('class="chat-tool-card__args"');
  assert.ok(argsAt >= 0, "缺参数折叠 details 容器");
  const detailsTag = source.slice(argsAt, argsAt + 500);
  assert.match(
    detailsTag,
    /@click=\$\{\(event: Event\) => event\.stopPropagation\(\)\}/,
    "参数折叠缺 click 拦截",
  );
  assert.match(
    detailsTag,
    /@keydown=\$\{\(event: KeyboardEvent\) => event\.stopPropagation\(\)\}/,
    "参数折叠缺 keydown 拦截",
  );
});

test("tool-cards 源码：整卡 click/keydown 入口忽略卡内嵌套控件，输出区保留 click 拦截", () => {
  const source = toolCardsSource();
  assert.ok(source.includes("export function isNestedToolCardControl"), "缺嵌套控件判定 helper");
  const clickAt = source.indexOf("const handleClick = canClick");
  assert.ok(clickAt >= 0, "缺整卡 handleClick");
  assert.match(
    source.slice(clickAt, clickAt + 800),
    /isNestedToolCardControl\(event\.target, event\.currentTarget\)/,
    "整卡 click 未过滤嵌套控件",
  );
  const keyAt = source.indexOf('e.key !== "Enter"');
  assert.ok(keyAt >= 0, "缺整卡 keydown 处理");
  assert.match(
    source.slice(keyAt, keyAt + 800),
    /isNestedToolCardControl\(e\.target, e\.currentTarget\)/,
    "整卡 keydown 未过滤嵌套控件",
  );
  const outputAt = source.indexOf('class="chat-tool-card__output chat-text"');
  assert.ok(outputAt >= 0, "缺输出区容器");
  assert.match(
    source.slice(outputAt, outputAt + 300),
    /@click=\$\{\(event: Event\) => event\.stopPropagation\(\)\}/,
    "输出区缺 click 拦截",
  );
});

test("isNestedToolCardControl：卡内控件/卡片自身/外层折叠 details 的判定", () => {
  const summaryNode = { tag: "summary" };
  const summaryTarget = { closest: () => summaryNode };
  const outerDetailsNode = { tag: "outer-details" };
  const outerTarget = { closest: () => outerDetailsNode };
  const cardRoot = { contains: (node: unknown) => node === summaryNode };

  assert.equal(
    isNestedToolCardControl(summaryTarget, cardRoot),
    true,
    "卡内 summary 的交互应归控件自身，不打开 sidebar",
  );
  assert.equal(
    isNestedToolCardControl(outerTarget, cardRoot),
    false,
    "外层工具折叠 details 是卡片祖先，不能误判为卡内控件",
  );
  assert.equal(isNestedToolCardControl(cardRoot, cardRoot), false, "卡片根节点自身仍应打开 sidebar");
  assert.equal(isNestedToolCardControl(null, cardRoot), false);
  assert.equal(isNestedToolCardControl({}, cardRoot), false);
  assert.equal(isNestedToolCardControl({ closest: () => null }, cardRoot), false);
});


