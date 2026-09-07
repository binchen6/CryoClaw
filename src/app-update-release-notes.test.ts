import test from "node:test";
import assert from "node:assert/strict";
import { parseReleaseBodyNotes } from "./app-update-release-notes";

const sampleBody = [
  "## 中文",
  "- 内核升级：openclaw 2026.8.2 → 2026.9.2。修复 asar 形态硬阻断——补丁扫描现已覆盖 fs-safe 包",
  "- 安装体积：gateway.asar 减约 10MB",
  "",
  "## English",
  "- Kernel upgrade: openclaw 2026.8.2 -> 2026.9.2. Fixes the hard asar blocker",
  "- Install size: gateway.asar shrinks by ~10MB",
  "",
  "> 安装包未签名（本机未配置代码签名证书），首次安装可能出现 Windows SmartScreen 提示。/ The installer is unsigned.",
].join("\n");

test("parseReleaseBodyNotes：按二级标题切分中英文段落", () => {
  const notes = parseReleaseBodyNotes(sampleBody);
  assert.ok(notes);
  assert.match(notes.zh!, /内核升级：openclaw 2026\.8\.2 → 2026\.9\.2/);
  assert.match(notes.zh!, /安装体积：gateway\.asar 减约 10MB/);
  assert.match(notes.en!, /Kernel upgrade/);
  assert.equal(notes.zh!.includes("- "), false, "应剥掉 markdown 弹点");
});

test("parseReleaseBodyNotes：块引用（签名/免责说明）不进更新弹窗", () => {
  const notes = parseReleaseBodyNotes(sampleBody)!;
  assert.equal(notes.zh!.includes("SmartScreen"), false);
  assert.equal(notes.en!.includes("unsigned"), false);
});

test("parseReleaseBodyNotes：中英文段落顺序颠倒也能解析", () => {
  const body = "## English\n- alpha\n\n## 中文\n- 甲\n";
  const notes = parseReleaseBodyNotes(body)!;
  assert.equal(notes.en, "alpha");
  assert.equal(notes.zh, "甲");
});

test("parseReleaseBodyNotes：无标题/空正文返回 null", () => {
  assert.equal(parseReleaseBodyNotes(""), null);
  assert.equal(parseReleaseBodyNotes("just some text without headings"), null);
  assert.equal(parseReleaseBodyNotes("## Français\n- bonjour"), null);
});

test("parseReleaseBodyNotes：真实 release 正文（v2026.909.6 格式）可解析出双段落", () => {
  const notes = parseReleaseBodyNotes(sampleBody)!;
  assert.ok(notes.zh && notes.en, "中英文段落都应存在");
  assert.equal(notes.zh.split("\n").length, 2);
});

test("parseReleaseBodyNotes：三行标题形态（###）同样接受", () => {
  const body = "### 中文\n- 甲\n\n### English\n- alpha\n";
  const notes = parseReleaseBodyNotes(body)!;
  assert.equal(notes.zh, "甲");
  assert.equal(notes.en, "alpha");
});
