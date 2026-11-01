import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin, { parameters, requestEmbeddedBrowser } from "../builtin-plugins/cryoclaw-browser/index.mjs";

test("embedded browser plugin is discoverable without starting a browser", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("../builtin-plugins/cryoclaw-browser/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.contracts.tools, ["cryoclaw_browser"]);
  assert.equal(manifest.activation.onStartup, true);
  let factory;
  plugin.register({ registerTool(value) { factory = value; } });
  assert.equal(factory.contextVersion, 2);
  assert.equal(factory.create({ sandboxed: true }), null);
  assert.equal(factory.create({ messageChannel: "telegram" }), null);
  const tool = factory.create({ messageChannel: "webchat", assertInvocationCurrent() {} });
  assert.equal(tool.name, "cryoclaw_browser");
  assert.ok(parameters.properties.action.enum.includes("snapshot"));
});

test("Agent client uses the authenticated local control route and returns real UI results", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cryo-browser-plugin-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(stateDir, "cryoclaw.config.json"), JSON.stringify({ gatewayControl: { port: 17893, token: "test-control-token" } }));
  let request;
  const result = await requestEmbeddedBrowser({ action: "navigate", url: "https://example.com" }, {
    stateDir,
    async fetchImpl(url, init) {
      request = { url, init };
      return { ok: true, status: 200, async json() { return { ok: true, result: { visible: true, url: "https://example.com" } }; } };
    },
  });
  assert.equal(request.url, "http://127.0.0.1:17893/ui/browser");
  assert.equal(request.init.headers.authorization, "Bearer test-control-token");
  assert.deepEqual(JSON.parse(request.init.body), { action: "navigate", url: "https://example.com" });
  assert.equal(result.visible, true);
});

test("Agent client preserves control errors and cancellation", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cryo-browser-plugin-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(stateDir, "cryoclaw.config.json"), JSON.stringify({ gatewayControl: { port: 17893, token: "test-control-token" } }));
  await assert.rejects(requestEmbeddedBrowser({ action: "status" }, {
    stateDir,
    async fetchImpl() { return { ok: false, status: 400, async json() { return { ok: false, error: "Agent access disabled" }; } }; },
  }), /Agent access disabled/);
  await assert.rejects(requestEmbeddedBrowser({ action: "status" }, { stateDir, signal: AbortSignal.abort() }), /canceled/);
});
