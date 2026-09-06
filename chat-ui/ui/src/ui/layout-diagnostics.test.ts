import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseLayoutRect, diagnoseHorizontalOverflow } from "./layout-diagnostics.ts";

test("layout diagnostics reports viewport overflow and ignores contained rectangles", () => {
  assert.equal(diagnoseLayoutRect({ left: 0, top: 0, right: 800, bottom: 600 }, { width: 800, height: 600 }).length, 0);
  const issues = diagnoseLayoutRect({ left: -2, top: 0, right: 801, bottom: 600 }, { width: 800, height: 600 });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, "viewport-overflow");
});

test("horizontal overflow is reported for normal panes but skipped for scrollable or collapsed panes", () => {
  // 正常宽度容器溢出 → 上报
  assert.equal(diagnoseHorizontalOverflow(360, 300, "visible").length, 1);
  // 容器自带横向滚动 → 预期行为，不上报
  assert.equal(diagnoseHorizontalOverflow(360, 300, "auto").length, 0);
  assert.equal(diagnoseHorizontalOverflow(360, 300, "scroll").length, 0);
  // 折叠面板（窄屏被挤压到阈值以下）→ 不上报，页面级溢出由 viewport 检查兜底
  assert.equal(diagnoseHorizontalOverflow(214, 63, "hidden").length, 0);
  // 未溢出 → 不上报
  assert.equal(diagnoseHorizontalOverflow(300, 300, "visible").length, 0);
  assert.equal(diagnoseHorizontalOverflow(301, 300, "visible").length, 0);
});
