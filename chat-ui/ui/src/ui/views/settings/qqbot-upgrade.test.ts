import assert from "node:assert/strict";
import { test } from "node:test";
import { applyQqbotSave, extractQqbotView, QQBOT_PLUGIN_ID } from "./tab-channels.lib.ts";

test("QQ save migrates plugin identity without renaming its channel or dropping advanced fields", () => {
  const draft: any = {
    plugins: { allow: ["qqbot", "other"], deny: ["other-denied", "qqbot", "openclaw-qqbot"], entries: { qqbot: { enabled: true, config: { x: 1 } } }, installs: { qqbot: { source: "npm" } } },
    channels: { qqbot: { enabled: true, appId: "one", clientSecret: "__OPENCLAW_REDACTED__", groups: { "*": { historyLimit: 30 } }, accounts: { two: { appId: "two", clientSecretFile: "/secret", custom: true } } } },
  };
  applyQqbotSave(draft, { enabled: true, accountId: "two", accountEnabled: false, markdownSupport: false, streaming: true, dmPolicy: "allowlist", allowFrom: ["u1"], groupPolicy: "disabled", groupAllowFrom: [], transport: "webhook", webhookPath: "/qq/callback" } as any);
  assert.equal(QQBOT_PLUGIN_ID, "openclaw-qqbot");
  assert.equal(draft.plugins.entries.qqbot, undefined);
  assert.equal(draft.plugins.installs.qqbot, undefined);
  assert.deepEqual(draft.plugins.allow, ["openclaw-qqbot", "other"]);
  assert.deepEqual(draft.plugins.deny, ["other-denied", "openclaw-qqbot"]);
  assert.deepEqual(draft.plugins.entries["openclaw-qqbot"].config, { x: 1 });
  assert.equal(draft.channels.qqbot.clientSecret, "__OPENCLAW_REDACTED__");
  const account = draft.channels.qqbot.accounts.two;
  assert.equal(account.clientSecretFile, "/secret");
  assert.equal(account.custom, true);
  assert.equal(account.enabled, false);
  assert.deepEqual(account.streaming, { mode: "partial" });
  assert.deepEqual(account.webhook, { path: "/qq/callback" });
  assert.equal(account.upgradeMode, "doc");
  assert.equal(draft.channels.qqbot.enabled, true);
  assert.equal(draft.channels[QQBOT_PLUGIN_ID], undefined);
});

test("QQ account view reads named credentials and policies without inheriting default credentials", () => {
  const view: any = (extractQqbotView as any)({ channels: { qqbot: { enabled: true, appId: "default-id", accounts: { work: { name: "Work", appId: "work-id", clientSecret: "__OPENCLAW_REDACTED__", enabled: false, streaming: { mode: "partial" }, dmPolicy: "disabled", urlDirectUpload: false } } } } }, "work");
  assert.equal(view.appId, "work-id");
  assert.equal(view.accountEnabled, false);
  assert.equal(view.enabled, true);
  assert.equal(view.streaming, true);
  assert.equal(view.dmPolicy, "disabled");
  assert.equal(view.urlDirectUpload, false);
  assert.deepEqual(view.accounts.map((a: any) => a.accountId), ["default", "work"]);
});

test("QQ policy edits preserve redacted and file secrets; replacement clears only selected secret file", () => {
  const draft: any = { channels: { qqbot: { enabled: true, appId: "a", clientSecret: "__OPENCLAW_REDACTED__", clientSecretFile: "/old", accounts: { b: { appId: "b", clientSecretFile: "/b" } } } } };
  applyQqbotSave(draft, { enabled: true, markdownSupport: true });
  assert.equal(draft.channels.qqbot.clientSecret, "__OPENCLAW_REDACTED__");
  assert.equal(draft.channels.qqbot.clientSecretFile, "/old");
  applyQqbotSave(draft, { enabled: true, accountId: "b", clientSecret: "new-secret" } as any);
  assert.equal(draft.channels.qqbot.accounts.b.clientSecret, "new-secret");
  assert.equal(draft.channels.qqbot.accounts.b.clientSecretFile, undefined);
  assert.equal(draft.channels.qqbot.clientSecretFile, "/old");
});

test("QQ disabling preserves every account and credential", () => {
  const draft: any = { channels: { qqbot: { enabled: true, appId: "a", clientSecret: "secret", accounts: { b: { appId: "b", enabled: true } } } } };
  applyQqbotSave(draft, { enabled: false, appId: "" });
  assert.equal(draft.channels.qqbot.appId, "a");
  assert.equal(draft.channels.qqbot.accounts.b.enabled, true);
  assert.equal(draft.plugins.entries["openclaw-qqbot"].enabled, false);
});
