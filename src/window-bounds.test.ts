import test from "node:test";
import assert from "node:assert/strict";
import { defaultWindowSize, isBoundsUsable } from "./window-bounds";

// window-bounds 的纯函数：默认尺寸（工作区 80%，不低于最小约束）与
// 持久化 bounds 可用性校验（尺寸合法 + 与任一显示器足够重叠）。

test("defaultWindowSize：按工作区 80% 计算默认尺寸", () => {
  assert.deepEqual(defaultWindowSize({ width: 1920, height: 1080 }), {
    width: 1536,
    height: 864,
  });
});

test("defaultWindowSize：小屏工作区不低于最小约束 800×600", () => {
  assert.deepEqual(defaultWindowSize({ width: 900, height: 700 }), {
    width: 800,
    height: 600,
  });
});

const WORK_AREAS = [
  { x: 0, y: 0, width: 1920, height: 1040 },
  { x: 1920, y: 0, width: 2560, height: 1440 },
];

test("isBoundsUsable：主屏内常规 bounds 可用", () => {
  assert.equal(isBoundsUsable({ x: 100, y: 80, width: 1536, height: 864 }, WORK_AREAS), true);
});

test("isBoundsUsable：副屏 bounds 可用", () => {
  assert.equal(isBoundsUsable({ x: 2000, y: 100, width: 1200, height: 800 }, WORK_AREAS), true);
});

test("isBoundsUsable：尺寸小于最小约束不可用", () => {
  assert.equal(isBoundsUsable({ x: 0, y: 0, width: 799, height: 864 }, WORK_AREAS), false);
  assert.equal(isBoundsUsable({ x: 0, y: 0, width: 1536, height: 599 }, WORK_AREAS), false);
});

test("isBoundsUsable：完全落在所有显示器之外不可用（拔掉外接屏场景）", () => {
  assert.equal(isBoundsUsable({ x: 5000, y: 100, width: 1200, height: 800 }, WORK_AREAS), false);
});

test("isBoundsUsable：只有边缘擦到显示器（重叠不足）不可用", () => {
  // bounds 右缘仅 50px 落在主屏内（-1150..50 vs 0..1920），低于 160px 见宽阈值
  assert.equal(isBoundsUsable({ x: -1150, y: 100, width: 1200, height: 800 }, WORK_AREAS), false);
});

test("isBoundsUsable：非数值尺寸不可用", () => {
  assert.equal(isBoundsUsable({ width: Number.NaN, height: 800 }, WORK_AREAS), false);
});
