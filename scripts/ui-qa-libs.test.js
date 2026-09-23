// ui-qa-libs.test.js — CDP 冒烟共用库（lib/）的轻量单测。
//
// 这些库导出的是"在页面上下文求值的表达式字符串"，无法在无 DOM 的 node:test 里执行，
// 但可以做两件高价值校验：
//   1. 表达式语法合法（new Function 编译即解析——历史上 ::placeholder 这类选择器错误、
//      正则转义错误都是冒烟跑起来才爆，现在在单元测试阶段就拦住）；
//   2. cdp-harness 的纯函数（arg 参数解析）行为。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { bareI18nScanExpr } = require("./lib/bare-i18n-scan.js");
const { overlapCheckExpr } = require("./lib/overlap-scan.js");
const { textOverflowScanExpr, contrastScanExpr } = require("./lib/text-quality-scan.js");
const { arg } = require("./lib/cdp-harness.js");

function assertCompiles(name, expr) {
  assert.equal(typeof expr, "string", `${name} 应返回字符串表达式`);
  assert.doesNotThrow(() => new Function(`"use strict"; return (${expr});`), `${name} 表达式应能通过 JS 解析`);
}

test("扫描表达式语法合法", () => {
  assertCompiles("bareI18nScanExpr", bareI18nScanExpr());
  assertCompiles("overlapCheckExpr(viewportOnly)", overlapCheckExpr());
  assertCompiles("overlapCheckExpr(!viewportOnly)", overlapCheckExpr({ viewportOnly: false }));
  assertCompiles("textOverflowScanExpr", textOverflowScanExpr());
  assertCompiles("contrastScanExpr", contrastScanExpr());
});

test("表达式为自执行函数且返回 JSON 字符串", () => {
  for (const expr of [bareI18nScanExpr(), overlapCheckExpr(), textOverflowScanExpr(), contrastScanExpr()]) {
    assert.match(expr.trim(), /^\(\(\) => \{/, "应以 IIFE 开头");
    assert.ok(expr.includes("JSON.stringify"), "结果应序列化为 JSON 字符串");
  }
});

test("overlapCheckExpr viewportOnly 分支生效", () => {
  assert.ok(overlapCheckExpr().includes("innerWidth"), "默认应与视口求交");
  assert.ok(!overlapCheckExpr({ viewportOnly: false }).includes("innerWidth"), "关闭后不含视口求交");
});

test("textOverflowScan 不申报 ellipsis（有意截断）", () => {
  const expr = textOverflowScanExpr();
  assert.ok(expr.includes("textOverflow"), "应检查 textOverflow 计算样式");
  assert.ok(expr.includes("pageHOverflow"), "应输出 body 横向滚动条判定");
});

test("cdp-harness arg 解析", () => {
  const argv = ["node", "x.js", "--port", "9223", "--exe", "C:\\app.exe", "--strict-layout"];
  assert.equal(arg(argv, "--port", "1"), "9223");
  assert.equal(arg(argv, "--exe", null), "C:\\app.exe");
  assert.equal(arg(argv, "--missing", "fallback"), "fallback");
  assert.equal(arg([], "--port", "9223"), "9223");
});
