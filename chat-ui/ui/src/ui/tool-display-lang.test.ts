import test from "node:test";
import assert from "node:assert/strict";

import { inferLanguageFromPath, resolveToolLanguage } from "./tool-display.ts";

// ── R52 T4：工具输出语言推断 ──

test("inferLanguageFromPath：常见扩展名映射到 hljs 已注册语言", () => {
  assert.equal(inferLanguageFromPath("src/main.ts"), "typescript");
  assert.equal(inferLanguageFromPath("src/app.tsx"), "typescript");
  assert.equal(inferLanguageFromPath("a/b/index.js"), "javascript");
  assert.equal(inferLanguageFromPath("script.py"), "python");
  assert.equal(inferLanguageFromPath("data.json"), "json");
  assert.equal(inferLanguageFromPath("deploy.sh"), "bash");
  assert.equal(inferLanguageFromPath("page.html"), "html");
  assert.equal(inferLanguageFromPath("icon.svg"), "xml");
  assert.equal(inferLanguageFromPath("main.go"), "go");
  assert.equal(inferLanguageFromPath("lib.rs"), "rust");
  assert.equal(inferLanguageFromPath("config.yaml"), "yaml");
  assert.equal(inferLanguageFromPath("ci.yml"), "yaml");
});

test("inferLanguageFromPath：Windows 路径 / 大小写 / 查询串容错", () => {
  assert.equal(inferLanguageFromPath("C:\\code\\x\\run.ps1"), "powershell");
  assert.equal(inferLanguageFromPath("SRC/MAIN.TS"), "typescript");
  assert.equal(inferLanguageFromPath("/tmp/a.css?raw=1"), "css");
});

test("inferLanguageFromPath：无扩展名/点号文件/未映射扩展名返回 undefined", () => {
  assert.equal(inferLanguageFromPath("Makefile"), undefined);
  assert.equal(inferLanguageFromPath(".gitignore"), undefined);
  assert.equal(inferLanguageFromPath("docs/note.md"), undefined);
  assert.equal(inferLanguageFromPath("archive.zip"), undefined);
  assert.equal(inferLanguageFromPath(""), undefined);
  assert.equal(inferLanguageFromPath("   "), undefined);
});

test("resolveToolLanguage：read/write/edit/apply_patch 经 langFrom 声明从 path 推断", () => {
  for (const name of ["read", "write", "edit", "apply_patch"]) {
    assert.equal(resolveToolLanguage(name, { path: "src/a.ts" }), "typescript", name);
  }
});

test("resolveToolLanguage：非文件工具/缺 path/未映射扩展名返回 undefined", () => {
  assert.equal(resolveToolLanguage("exec", { command: "ls" }), undefined);
  assert.equal(resolveToolLanguage("read", {}), undefined);
  assert.equal(resolveToolLanguage("read", { path: "README" }), undefined);
  assert.equal(resolveToolLanguage(undefined, undefined), undefined);
  // 工具名大小写宽容（规范化后命中 json 声明）
  assert.equal(resolveToolLanguage("Read", { path: "a.go" }), "go");
});
