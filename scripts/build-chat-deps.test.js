"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { ensureDependencies, canReuseDependencies } = require("./lib/build-chat-deps");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-build chat &(x86)-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { npm_config_userconfig: path.join(root, "user.npmrc"), npm_config_globalconfig: path.join(root, "global.npmrc") };
  const stamp = path.join(root, "node_modules", ".cryoclaw-build-deps.json");
  const put = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  put("global.npmrc", "omit=optional");
  put("package.json", { devDependencies: { vite: "1.0.0" } });
  put("package-lock.json", { lockfileVersion: 3, packages: {} });
  const install = () => {
    put("node_modules/.package-lock.json", { lockfileVersion: 3, packages: {
      "node_modules/vite": { version: "1.0.0" }, "node_modules/leaf": { version: "2.0.0" },
    } });
    put("node_modules/vite/package.json", { version: "1.0.0", bin: { vite: "bin/vite.js" } });
    put("node_modules/vite/bin/vite.js", "// test fixture, not a real build");
    put("node_modules/leaf/package.json", { version: "2.0.0" });
  };
  return { root, env, stamp, put, install };
}

test("cold prepare installs once; unchanged warm prepare does no npm work", (t) => {
  const f = fixture(t);
  let installs = 0;
  const install = () => { installs++; f.install(); };
  assert.deepEqual(ensureDependencies(f.root, install, f.env), { reused: false });
  for (let i = 0; i < 8; i++) assert.deepEqual(ensureDependencies(f.root, install, f.env), { reused: true });
  assert.equal(installs, 1);
});

for (const [name, change] of [
  ["manifest", (f) => f.put("package.json", { devDependencies: { vite: "2.0.0" } })],
  ["lockfile", (f) => f.put("package-lock.json", { lockfileVersion: 3, packages: {}, changed: true })],
  ["project npmrc", (f) => f.put(".npmrc", "registry=https://example.invalid")],
  ["user npmrc", (f) => f.put("user.npmrc", "ignore-scripts=true")],
  ["global npmrc same-path content", (f) => f.put("global.npmrc", "include=optional")],
  ["npm config env", (f) => { f.env.npm_config_omit = "dev"; }],
  ["node env", (f) => { f.env.NODE_ENV = "production"; }],
  ["installed inventory", (f) => f.put("node_modules/.package-lock.json", "{}")],
  ["installed package version", (f) => f.put("node_modules/leaf/package.json", { version: "9.0.0" })],
  ["missing transitive package", (f) => fs.unlinkSync(path.join(f.root, "node_modules/leaf/package.json"))],
  ["missing Vite bin", (f) => fs.unlinkSync(path.join(f.root, "node_modules/vite/bin/vite.js"))],
  ["corrupt stamp", (f) => f.put("node_modules/.cryoclaw-build-deps.json", "{")],
  ["forced refresh", (f) => { f.env.CRYOCLAW_FORCE_CHAT_INSTALL = "1"; }],
]) {
  test(`${name} invalidates the dependency stamp`, (t) => {
    const f = fixture(t);
    ensureDependencies(f.root, f.install, f.env);
    assert.equal(canReuseDependencies(f.root, f.env), true);
    change(f);
    assert.equal(canReuseDependencies(f.root, f.env), false);
    let installs = 0;
    ensureDependencies(f.root, () => { installs++; f.install(); }, f.env);
    assert.equal(installs, 1);
  });
}

test("unknown effective global configuration conservatively disables cache reuse", (t) => {
  const f = fixture(t);
  ensureDependencies(f.root, f.install, f.env);
  delete f.env.npm_config_globalconfig;
  let installs = 0;
  for (let i = 0; i < 2; i++) ensureDependencies(f.root, () => { installs++; f.install(); }, f.env);
  assert.equal(installs, 2);
});

test("failed install removes old stamp and the next attempt retries", (t) => {
  const f = fixture(t);
  ensureDependencies(f.root, f.install, f.env);
  f.env.CRYOCLAW_FORCE_CHAT_INSTALL = "1";
  assert.throws(() => ensureDependencies(f.root, () => { throw new Error("npm integrity error"); }, f.env), /npm integrity error/);
  assert.equal(fs.existsSync(f.stamp), false);
  delete f.env.CRYOCLAW_FORCE_CHAT_INSTALL;
  assert.equal(canReuseDependencies(f.root, f.env), false);
  assert.deepEqual(ensureDependencies(f.root, f.install, f.env), { reused: false });
});

test("incomplete tree after npm success is not stamped", (t) => {
  const f = fixture(t);
  assert.throws(() => ensureDependencies(f.root, () => {
    f.install(); f.put("node_modules/leaf/package.json", { version: "wrong" });
  }, f.env), /incomplete/);
  assert.equal(fs.existsSync(f.stamp), false);
});

test("build wrapper preserves spaced/metacharacter paths without a shell and always runs Vite", (t) => {
  const f = fixture(t);
  const { buildChat } = require("./build-chat");
  f.install();
  f.put("fake npm cli.cjs", `const fs=require('node:fs');fs.appendFileSync('npm-calls.jsonl',JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+'\\n');`);
  f.put("node_modules/vite/bin/vite.js", `require('node:fs').appendFileSync('vite-calls.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');`);
  const env = { ...process.env, ...f.env, npm_execpath: path.join(f.root, "fake npm cli.cjs") };
  assert.equal(buildChat(f.root, env), 0);
  assert.equal(buildChat(f.root, env), 0);
  const npmCalls = fs.readFileSync(path.join(f.root, "npm-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(npmCalls, [{ args: ["install", "--prefer-offline"], cwd: f.root }]);
  const viteCalls = fs.readFileSync(path.join(f.root, "vite-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(viteCalls, [["build"], ["build"]]);
});

test("npm failure propagates and never enables shell parsing", (t) => {
  const f = fixture(t);
  const { installDependencies } = require("./build-chat");
  f.put("fake npm cli.cjs", "");
  assert.throws(() => installDependencies(f.root, { npm_execpath: path.join(f.root, "fake npm cli.cjs") }, (_command, args, options) => {
    assert.equal(options.shell, false);
    assert.equal(options.cwd, f.root);
    assert.deepEqual(args.slice(1), ["install", "--prefer-offline"]);
    return { status: 17 };
  }), /npm install failed \(17\)/);
});

test("npm credentials are fingerprinted, never copied into the stamp", (t) => {
  const f = fixture(t);
  f.put("user.npmrc", "//registry.example/:_authToken=fixture-secret-only");
  ensureDependencies(f.root, f.install, f.env);
  assert.equal(fs.readFileSync(f.stamp, "utf8").includes("fixture-secret-only"), false);
});
