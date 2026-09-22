const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { hasDevStateIgnoreEntry, ensureDevStateIgnored } = require("./dev-isolated.js");

// 回归：dev-isolated.js 曾用子串 content.includes(".dev-state") 判断 .gitignore 是否已
// 忽略 .dev-state/，会被同仓库里的 `.dev-state-pkg/` 行骗过——判定为"已忽略"→ 跳过追加，
// 而 .dev-state/ 下的 credentials/（含 API key）实际没有 gitignore 兜底，存在入库泄漏路径。
// 这里钉住"按行精确匹配"的判定（接受 `.dev-state/` 与 `.dev-state` 两种写法）。

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-dev-isolated-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("hasDevStateIgnoreEntry：只有 .dev-state-pkg/ 行时判定为缺失", () => {
  const content = ["node_modules/", "out/", ".dev-state-pkg/", ""].join("\n");
  assert.equal(hasDevStateIgnoreEntry(content), false);
});

test("hasDevStateIgnoreEntry：.dev-state/ 与 .dev-state 两种写法都算存在", () => {
  assert.equal(hasDevStateIgnoreEntry("node_modules/\n.dev-state/\n"), true);
  assert.equal(hasDevStateIgnoreEntry("node_modules/\n.dev-state\n"), true);
});

test("hasDevStateIgnoreEntry：CRLF 行尾与行首尾空白同样识别", () => {
  assert.equal(hasDevStateIgnoreEntry("out/\r\n.dev-state/\r\n"), true);
  assert.equal(hasDevStateIgnoreEntry("out/\r\n.dev-state\r\n"), true);
  assert.equal(hasDevStateIgnoreEntry("  .dev-state/  \n"), true);
});

test("hasDevStateIgnoreEntry：注释行与相似名字不算覆盖", () => {
  assert.equal(hasDevStateIgnoreEntry("# .dev-state/\n"), false);
  assert.equal(hasDevStateIgnoreEntry(".dev-state-pkg/\n"), false);
  assert.equal(hasDevStateIgnoreEntry("foo.dev-state/\n"), false);
  assert.equal(hasDevStateIgnoreEntry(".dev-state-backup\n"), false);
  assert.equal(hasDevStateIgnoreEntry(".dev-state-pkg\n"), false);
  assert.equal(hasDevStateIgnoreEntry(""), false);
});

test("ensureDevStateIgnored：只有 .dev-state-pkg/ 行时追加 .dev-state/", (t) => {
  const dir = makeTempDir(t);
  const gitignorePath = path.join(dir, ".gitignore");
  fs.writeFileSync(gitignorePath, "node_modules/\n.dev-state-pkg/\n", "utf-8");

  assert.equal(ensureDevStateIgnored(gitignorePath), true);

  const lines = fs.readFileSync(gitignorePath, "utf-8").split(/\r?\n/);
  assert.equal(lines.includes(".dev-state/"), true);
  // 原有内容不受影响
  assert.equal(lines.includes(".dev-state-pkg/"), true);
  assert.equal(lines.includes("node_modules/"), true);
});

test("ensureDevStateIgnored：已有 .dev-state/ 行时不重复追加", (t) => {
  const dir = makeTempDir(t);
  const gitignorePath = path.join(dir, ".gitignore");
  const original = "node_modules/\n.dev-state-pkg/\n.dev-state/\n";
  fs.writeFileSync(gitignorePath, original, "utf-8");

  assert.equal(ensureDevStateIgnored(gitignorePath), false);
  assert.equal(fs.readFileSync(gitignorePath, "utf-8"), original);
});

test("ensureDevStateIgnored：无 .gitignore 时不创建", (t) => {
  const dir = makeTempDir(t);
  const gitignorePath = path.join(dir, ".gitignore");

  assert.equal(ensureDevStateIgnored(gitignorePath), false);
  assert.equal(fs.existsSync(gitignorePath), false);
});
