const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { adaptQQBotStartupBundle, applyManagedQQBotPolicy } = require("./lib/managed-qqbot");

// Exact upstream function bodies, checked in so clean checkouts need no npm cache.
const fixture = fs.readFileSync(path.join(__dirname, "fixtures/tencent-qqbot-2.0.4-lifecycle.cjs"), "utf8");
const pkg = { name: "@tencent-connect/openclaw-qqbot", version: "2.0.4", main: "dist/index.cjs" };

function lifecycle(bundle) {
  const events = [], requests = [], options = [];
  const logger = { child: () => logger, info: () => {}, debug: () => {} };
  const context = {
    triggerUpdateCheck: () => events.push("auto-update"),
    getApprovalHandler: () => ({ stop: async () => events.push("stop-existing") }),
    unregisterApprovalHandler: id => events.push(`unregister:${id}`),
    registerApprovalHandler: id => events.push(`register:${id}`),
    QQBotApprovalHandler: class { constructor(value) { options.push(value); } async start() { events.push("start"); } },
    CURRENT_VERSION: "2.0.4", PLUGIN_VERSION2: "2.0.4", GITHUB_URL: "https://github.com/tencent-connect/openclaw-qqbot",
    getOpenClawVersion: () => "2026.10.9",
    fetchDistTags: async () => { requests.push("manual-registry-check"); return { latest: "2.0.5" }; },
    buildUpdateInfo: tags => ({ checkedAt: 1, hasUpdate: true, latest: tags.latest }),
    setTimeout: () => { throw new Error("Automatic update timer must not be scheduled"); },
  };
  const api = vm.runInNewContext(`${bundle}\n;({initFeatures, botVersion, getUpdateInfo});`, context);
  return { api, events, requests, options, logger };
}

test("managed QQ gateway ready never prewarms versions, preserving approval setup and config", async () => {
  const adapted = adaptQQBotStartupBundle(fixture, pkg);
  for (const upgradeMode of ["doc", "auto"]) {
    const state = lifecycle(adapted), cfg = { channels: { qqbot: { upgradeMode } } };
    await state.api.initFeatures({ accountId: "primary", appId: "fixture", clientSecret: "fixture" }, cfg, state.logger);
    assert.deepEqual(state.events, ["stop-existing", "unregister:primary", "register:primary", "start"]);
    assert.deepEqual(state.requests, []);
    assert.equal(state.options[0].cfg, cfg);
  }
});

test("upstream fixture reproduces the automatic check even in doc mode", async () => {
  const state = lifecycle(fixture);
  await state.api.initFeatures({ accountId: "fixture" }, { channels: { qqbot: { upgradeMode: "doc" } } }, state.logger);
  assert.equal(state.events.filter(event => event === "auto-update").length, 1);
});

test("managed QQ retains actual bot-version and getUpdateInfo manual behavior", async () => {
  const adapted = adaptQQBotStartupBundle(fixture, pkg), state = lifecycle(adapted);
  const manualStart = fixture.indexOf("async function getUpdateInfo(");
  assert.equal(adapted.slice(adapted.indexOf("async function getUpdateInfo(")), fixture.slice(manualStart));
  assert.deepEqual(state.requests, []);
  const command = state.api.botVersion({});
  assert.equal(command.name, "bot-version");
  assert.deepEqual(state.requests, []);
  const output = await command.handler();
  assert.match(output, /2026\.10\.9/);
  assert.match(output, /2\.0\.4/);
  assert.match(output, /2\.0\.5/);
  assert.deepEqual(state.requests, ["manual-registry-check"]);
  await state.api.getUpdateInfo(state.logger);
  assert.equal(state.requests.length, 2);
});

test("QQ conversion is idempotent and rejects identity, version and function contract drift", () => {
  const adapted = adaptQQBotStartupBundle(fixture, pkg);
  assert.equal(adaptQQBotStartupBundle(adapted, pkg), adapted);
  for (const change of [{ name: "@openclaw/qqbot" }, { version: "2.0.5" }, { main: "dist/changed.cjs" }]) {
    assert.throws(() => adaptQQBotStartupBundle(fixture, { ...pkg, ...change }), /contract|identity|version/i);
  }
  for (const source of [fixture.replace("triggerUpdateCheck(log4);", "triggerUpdateCheck(log4, cfg);"),
    fixture.replace('approvalLog.info("registered");', 'approvalLog.info("changed");'), fixture + fixture]) {
    assert.throws(() => adaptQQBotStartupBundle(source, pkg), /contract/i);
  }
});

test("file adaptation fails closed on a same-version unknown build before writing", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  const bundlePath = path.join(root, "dist/index.cjs");
  for (const bundle of [fixture, adaptQQBotStartupBundle(fixture, pkg)]) {
    fs.writeFileSync(bundlePath, bundle);
    assert.throws(() => applyManagedQQBotPolicy(root), error => /build|SHA|hash/i.test(error.message) &&
      error.code === "CRYOCLAW_QQBOT_MANAGED_CONTRACT");
    assert.equal(fs.readFileSync(bundlePath, "utf8"), bundle);
  }
});
