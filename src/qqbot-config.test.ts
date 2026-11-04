import test from "node:test";
import assert from "node:assert/strict";
import { migrateQqbotPluginId } from "./qqbot-config";

test("QQ legacy wildcard migration preserves open chat without granting native approvals", () => {
  for (const policy of [undefined, "allowlist", "open", "pairing", "disabled"]) {
    const config: any = {channels:{qqbot:{dmPolicy:policy,allowFrom:["OWNER","*"],accounts:{team:{dmPolicy:policy,allowFrom:["*"]}}}}};
    migrateQqbotPluginId(config);
    const expected = policy === undefined || policy === "allowlist" ? "open" : policy;
    assert.equal(config.channels.qqbot.dmPolicy, expected);
    assert.equal(config.channels.qqbot.accounts.team.dmPolicy, expected);
    assert.deepEqual(config.channels.qqbot.allowFrom,["OWNER"]);
    assert.deepEqual(config.channels.qqbot.accounts.team.allowFrom,["openclaw:approval-disabled"]);
    assert.equal(migrateQqbotPluginId(config),false,"migration is idempotent");
  }
});
