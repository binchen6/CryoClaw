/** Isolated QQ settings renderer. All config and login effects stay in the fixture. */
import { render } from "../../chat-ui/ui/node_modules/lit/index.js";
import { renderChannelQqbot, resetQqbotTab } from "../../chat-ui/ui/src/ui/views/settings/tab-channels-qqbot.ts";
import { invalidateConfigSnapshotCache } from "../../chat-ui/ui/src/ui/controllers/config.ts";
import "../../chat-ui/ui/src/styles.css";

const w = window as any;
const initial = {
  plugins: { allow: ["qqbot", "other"], entries: { qqbot: { enabled: true } } },
  channels: { qqbot: { enabled: true, appId: "1001", clientSecret: "__OPENCLAW_REDACTED__", groups: { "*": { historyLimit: 31 } }, accounts: { work: { name: "Work", appId: "2002", clientSecretFile: "/fixture/secret", enabled: true, customAdvanced: { retain: true }, dmPolicy: "allowlist", allowFrom: ["USER_A"], groupPolicy: "allowlist", groupAllowFrom: ["GROUP_A"] } } } },
};
let config: any = structuredClone(initial);
let version = 1;
function merge(target: any, patch: any) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (value && typeof value === "object" && !Array.isArray(value)) { target[key] ??= {}; merge(target[key], value); }
    else target[key] = value;
  }
}
let queued = false;
const fixture = w.__qqFixture = {
  gatewayReady: true, linked: false, patchCount: 0, getCount: 0,
  config: () => config,
  reset: () => { resetQqbotTab(); invalidateConfigSnapshotCache(); config = structuredClone(initial); fixture.gatewayReady = true; fixture.linked = false; state.requestUpdate(); },
  leave: () => { resetQqbotTab(); render(null, document.querySelector("#app")!); },
};
const state: any = {
  connected: true,
  client: { request: async (method: string, params: any) => {
    if (method === "config.get") {
      fixture.getCount++;
      if (!fixture.gatewayReady) throw new Error("fixture gateway restarting");
      if (fixture.linked) config.channels.qqbot.accounts["3003"] = { appId: "3003", clientSecret: "__OPENCLAW_REDACTED__", enabled: true, dmPolicy: "allowlist", allowFrom: ["SCANNER"], upgradeMode: "doc" };
      return { config: structuredClone(config), hash: `fixture-${version}`, raw: null };
    }
    if (method === "config.patch") {
      fixture.patchCount++; merge(config, JSON.parse(params.raw)); version++;
      return { ok: true, config: structuredClone(config), hash: `fixture-${version}` };
    }
    throw new Error(`Unexpected fixture RPC: ${method}`);
  } },
  requestUpdate: () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; render(renderChannelQqbot(state), document.querySelector("#app")!); });
  },
};
state.requestUpdate();
