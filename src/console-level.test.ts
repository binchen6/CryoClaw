import test from "node:test";
import assert from "node:assert/strict";
import { formatConsoleLevel } from "./console-level";

test("formatConsoleLevel：Electron legacy 数字 level 0-3 映射", () => {
  assert.equal(formatConsoleLevel(0), "VERBOSE");
  assert.equal(formatConsoleLevel(1), "INFO");
  assert.equal(formatConsoleLevel(2), "WARNING");
  assert.equal(formatConsoleLevel(3), "ERROR");
});

test("formatConsoleLevel：越界 level 回退 LEVEL_n", () => {
  assert.equal(formatConsoleLevel(4), "LEVEL_4");
  assert.equal(formatConsoleLevel(-1), "LEVEL_-1");
});
