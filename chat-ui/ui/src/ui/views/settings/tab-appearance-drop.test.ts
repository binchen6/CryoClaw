// tab-appearance-drop.test.ts — 外观页主题模块拖放冲突修复钉点（源码审计）。
// 外层主题模块整区与内层「让 Agent 设计主题」参考图区是嵌套的两个 drop 目标：
// - 悬停参考图区时外层「松手导入 .json 主题包」高亮必须熄灭（两处高亮并存会提示与行为相反）；
// - 参考图区 drop 必须先无条件收尾（preventDefault/stopPropagation/清高亮）再过滤图片，
//   否则拖 .json 到参考图区会冒泡被外层误导入，且无图片文件时高亮卡死；
// - 外层 drop 对纯图片须静默忽略，不弹「请选择 .json 主题包」错误。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/views/settings/（上 6 级到 chat-ui/ui），源文件位于 chat-ui/ui/src/ui/
function src(rel: string): string {
  return readFileSync(new URL(`../../../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

// 剥掉块注释与行注释：断言只针对真实代码，防注释中的字样误匹配
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function handlerBodies(code: string, attr: "dragover" | "drop"): string[] {
  return [...code.matchAll(new RegExp(`@${attr}=\\$\\{\\(event:DragEvent\\)=>\\{[\\s\\S]*?\\}\\}`, "g"))].map(match => match[0]);
}

const code = stripComments(src("views/settings/tab-appearance.ts"));

test("tab-appearance.ts：参考图区 dragover 悬停时熄灭外层主题模块高亮", () => {
  const refsDragover = handlerBodies(code, "dragover").find(body => body.includes("agentImageDrag=true")) ?? "";
  assert.ok(refsDragover, "应找到参考图区 dragover 处理器");
  assert.ok(refsDragover.includes("themeDropActive=false"), "悬停参考图区时应清掉外层 themeDropActive，两处高亮互斥");
});

test("tab-appearance.ts：参考图区 drop 在图片过滤前无条件收尾", () => {
  const refsDrop = handlerBodies(code, "drop").find(body => body.includes("addThemeReferences")) ?? "";
  assert.ok(refsDrop, "应找到参考图区 drop 处理器");
  const filter = refsDrop.indexOf('startsWith("image/")');
  assert.ok(filter > -1, "参考图区 drop 应按 image/* 过滤");
  assert.ok(refsDrop.indexOf("preventDefault") < filter, "preventDefault 应先于图片过滤执行");
  assert.ok(refsDrop.indexOf("stopPropagation") < filter, "stopPropagation 应先于图片过滤执行（防冒泡到外层误导入）");
  assert.ok(refsDrop.indexOf("agentImageDrag=false") < filter, "清 agentImageDrag 应先于图片过滤执行（防高亮卡死）");
  assert.ok(refsDrop.includes('t("settings.appearance.themeAgent.referenceType")'), "无图片文件时应复用 referenceType 提示仅支持图片");
});

test("tab-appearance.ts：外层主题模块 drop 对纯图片静默忽略", () => {
  const outerDrop = handlerBodies(code, "drop").find(body => body.includes("importThemeFile")) ?? "";
  assert.ok(outerDrop, "应找到外层主题模块 drop 处理器");
  const every = outerDrop.indexOf("every(");
  const importCall = outerDrop.indexOf("importThemeFile");
  assert.ok(every > -1 && importCall > -1 && every < importCall, "应先有 image-only 静默忽略分支，再调 importThemeFile");
  assert.ok(outerDrop.includes('startsWith("image/")'), "静默忽略分支应按 image/* 判定");
});
