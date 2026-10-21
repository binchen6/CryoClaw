// 守护回归（源码审计，同 oc-turn-files-behavior.test.ts / oc-chat-history.test.ts 模式）：
// 终态「本轮改动」卡片（oc-turn-diff-card）是胶囊的终态接力——结构、降级、
// 折叠、事件委托复用等不变量钉在这里。组件依赖 lit + customElements，
// node 下直接导入意义不大，故读源断言。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../../../../../src/ui/components/oc-turn-diff-card.ts", import.meta.url),
  "utf8",
);

test("diff-card：无 shadow DOM + 注册为 oc-turn-diff-card", () => {
  assert.match(src, /createRenderRoot\(\)\s*\{\s*return this;/, "必须复用全局样式与线程事件委托");
  assert.match(src, /customElement\("oc-turn-diff-card"\)/, "必须以 oc-turn-diff-card 标签名注册");
});

test("diff-card：files 为空渲染 nothing；行数统计防抖 + 签名缓存 + 过期丢弃", () => {
  assert.match(src, /if \(!files\.length\) return nothing;/, "空文件列表不应渲染卡片");
  assert.match(src, /STATS_DEBOUNCE_MS = 250/, "统计拉取应 250ms 防抖");
  assert.match(src, /turnStatsSignature\(this\.workspacePath, paths\)/, "应按签名缓存");
  assert.match(src, /seq !== this\.statsSeq \|\| signature !== this\.statsSignature/, "过期响应应丢弃");
  // 统计不可用时不打 git：无工作区 / 无 git / 空文件列表直接空结果
  assert.match(src, /fetchTurnFileStats\(\s*statsBridge\(\)\?\.gitChangeStats,/, "应复用 turn-file-stats 拉取通道");
});

test("diff-card：头部「已编辑 N 个文件」+ 总 +x −y，行数不可用时降级文件数", () => {
  assert.match(src, /t\("chat\.editedFiles"\)\.replace\("\{n\}", String\(files\.length\)\)/);
  assert.match(src, /chat-turn-files__stat chat-turn-files__stat--added/, "总增行数复用胶囊统计配色类");
  assert.match(src, /chat-turn-files__stat chat-turn-files__stat--deleted/);
  assert.match(src, /lineStats \? summary\.additions : summary\.addedFiles/, "行数不可用时降级新增文件数");
  assert.match(src, /chat\.fileChange\.linesUnavailable/, "降级时 title 须说明原因");
});

test("diff-card：操作按钮仅 git 可用时渲染（撤销回调 + 查看变更委托）", () => {
  assert.match(src, /this\.gitAvailable[\s\S]*?chat\.undoChanges[\s\S]*?chat\.viewChanges/, "撤销/查看变更应在 git 可用分支内");
  assert.match(src, /this\.onDiscard\(this\.files\)/, "撤销应携带本组 files 调回调");
  assert.match(src, /\?disabled=\$\{this\.undoing\}/, "撤销在途应禁用按钮（busy 惯例）");
  assert.match(src, /class="chat-git-view-link" tabindex="0" role="button"/, "查看变更应复用线程委托链接结构");
  assert.doesNotMatch(src, /#(?:[0-9a-fA-F]{3}){1,2}\b/, "渲染层不得硬编码 hex");
});

test("diff-card：文件行 basename + 完整路径 title + 每文件 +/−；超出折叠「再显示 N 个」", () => {
  assert.match(src, /fileChangeBaseName\(file\.path\)/, "文件行应显示 basename");
  assert.match(src, /data-path=\$\{file\.path\}[\s\S]{0,80}title=\$\{file\.path\}/, "完整路径放 title + data-path（线程委托打开）");
  assert.match(src, /class="chat-path-link chat-turn-diff-card__path"/, "路径点击应复用 .chat-path-link 委托");
  assert.match(src, /files\.slice\(0, COLLAPSED_FILE_ROWS\)/, "默认只显示前 3 个文件");
  assert.match(src, /t\("chat\.showMoreFiles"\)\.replace\("\{n\}", String\(hiddenCount\)\)/, "超出行应可展开");
  // 二进制/无统计文件不显示行内数字（沿用胶囊语义）
  assert.match(src, /if \(!stat \|\| stat\.binary\) return nothing;/);
});

test("diff-card：shouldUpdate 放行视觉属性、拦回调新闭包", () => {
  assert.match(src, /shouldUpdate\(changed[^)]*\)[\s\S]{0,120}key !== "onDiscard"/, "回调属性不得触发重渲染");
});
