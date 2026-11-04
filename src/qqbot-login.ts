import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as path from "node:path";
import { migrateQqbotPluginId, QQBOT_PLUGIN_ID } from "./qqbot-config";

export interface QqbotCredentials { appId: string; appSecret: string; userOpenid?: string }
export interface QqbotCallbacks {
  onSuccess: (credentials: QqbotCredentials[]) => void;
  onFailure: (error: Error) => void;
  onQrDisplayed: (url: string) => void;
  onQrExpired: () => void;
}
export interface QqbotOwner {
  id: number;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}
export interface QqbotLoginDependencies {
  startQrConnect(callbacks: QqbotCallbacks, options: { displayQrCodeToConsole: false; source: string; signal: AbortSignal }): () => void;
  renderQr(url: string): Promise<string>;
  readConfig(): any;
  writeConfig(config: any): void;
  restart(): void;
  startupTimeoutMs?: number;
  deadlineMs?: number;
}
type Status = "waiting" | "connected" | "expired" | "error" | "canceled";
interface Attempt {
  id: string; owner: QqbotOwner; status: Status; qrDataUrl?: string; message: string;
  accounts?: Array<{ accountId: string; appId: string; name?: string }>;
  controller: AbortController; stop?: () => void; stopped: boolean; committed: boolean;
  qrGeneration: number; deadline: ReturnType<typeof setTimeout>; onDestroyed: () => void;
  ready: Promise<void>; resolveReady: () => void;
}

/** Resolve the connector and its QR encoder from the physical plugin, never app dependencies. */
export function loadOfficialQqbotBoundary(pluginDir: string): Pick<QqbotLoginDependencies, "startQrConnect" | "renderQr"> {
  const pluginRequire = createRequire(path.join(pluginDir, "package.json"));
  const connectorPath = pluginRequire.resolve("@tencent-connect/qqbot-connector");
  const connector = pluginRequire("@tencent-connect/qqbot-connector");
  const connectorRequire = createRequire(connectorPath);
  const terminalRequire = createRequire(connectorRequire.resolve("qrcode-terminal"));
  const QRCode = terminalRequire("../vendor/QRCode");
  const levels = terminalRequire("../vendor/QRCode/QRErrorCorrectLevel");
  return {
    startQrConnect: connector.startQrConnect,
    async renderQr(url) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.hostname !== "q.qq.com" || parsed.pathname !== "/qqbot/openclaw/connect.html") throw new Error("Unexpected QQ connect URL");
      const qr = new QRCode(-1, levels.M); qr.addData(url); qr.make();
      const size = qr.getModuleCount(), margin = 4;
      let cells = "";
      for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (qr.isDark(row, col)) cells += `M${col + margin},${row + margin}h1v1h-1z`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size + margin * 2} ${size + margin * 2}" shape-rendering="crispEdges"><path fill="white" d="M0 0h${size + margin * 2}v${size + margin * 2}H0z"/><path fill="black" d="${cells}"/></svg>`;
      return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    },
  };
}

/** Credentials exist only inside this synchronous main-process transaction. */
export function mergeQqbotCredentials(config: any, credentials: QqbotCredentials[]) {
  if (!Array.isArray(credentials) || credentials.length === 0 || credentials.some(c => !/^\d+$/.test(c?.appId) || typeof c?.appSecret !== "string" || !c.appSecret.trim())) throw new Error("Invalid QQ credentials");
  const channel = ((config.channels ??= {}).qqbot ??= {});
  const accounts = (channel.accounts ??= {});
  const summaries: Array<{ accountId: string; appId: string; name?: string }> = [];
  for (const c of credentials) {
    let accountId = channel.appId === c.appId ? "default" : Object.keys(accounts).find(key => accounts[key]?.appId === c.appId);
    const existing = accountId !== undefined;
    if (!accountId) {
      accountId = c.appId;
      for (let suffix = 2; Object.hasOwn(accounts, accountId); suffix++) accountId = `${c.appId}-${suffix}`;
    }
    const account = accountId === "default" ? channel : (accounts[accountId] ??= {});
    account.appId = c.appId; account.clientSecret = c.appSecret;
    if (!existing) {
      account.enabled = true;
      account.dmPolicy = "allowlist";
      account.allowFrom = c.userOpenid ? [c.userOpenid] : ["openclaw:approval-disabled"];
      account.streaming = { mode: "off" };
    }
    summaries.push({ accountId, appId: c.appId, ...(typeof account.name === "string" ? { name: account.name } : {}) });
  }
  channel.enabled ??= true;
  migrateQqbotPluginId(config);
  const plugins = (config.plugins ??= {}), entries = (plugins.entries ??= {});
  (entries[QQBOT_PLUGIN_ID] ??= {}).enabled ??= true;
  if (Array.isArray(plugins.allow) && !plugins.allow.includes(QQBOT_PLUGIN_ID)) plugins.allow.push(QQBOT_PLUGIN_ID);
  return summaries;
}

export function createQqbotLoginService(deps: QqbotLoginDependencies) {
  const attempts = new Map<string, Attempt>();
  const active = (a: Attempt) => a.status === "waiting" && !a.owner.isDestroyed() && attempts.get(a.id) === a;
  const stop = (a: Attempt) => {
    clearTimeout(a.deadline); a.owner.removeListener("destroyed", a.onDestroyed);
    a.controller.abort();
    if (a.stop && !a.stopped) { a.stopped = true; try { a.stop(); } catch { /* cancellation must stay terminal */ } }
  };
  const finish = (a: Attempt, status: Status, message: string) => {
    a.status = status; a.message = message;
    if (status !== "connected") a.qrGeneration++;
    stop(a);
    if (status !== "connected" || a.qrDataUrl) a.resolveReady();
  };
  const view = (a: Attempt) => ({ attemptId: a.id, status: a.status, message: a.message, ...(a.qrDataUrl ? { qrDataUrl: a.qrDataUrl } : {}), ...(a.accounts ? { accounts: a.accounts } : {}) });
  const owned = (owner: QqbotOwner, id: unknown) => typeof id === "string" && attempts.get(id)?.owner === owner ? attempts.get(id) : undefined;
  return {
    async start(owner: QqbotOwner) {
      if (owner.isDestroyed()) return { success: false, message: "QQ login window is closed." };
      for (const a of attempts.values()) if (a.owner === owner) { if (active(a)) finish(a, "canceled", "QQ login canceled."); attempts.delete(a.id); }
      // Terminal records contain no secrets and are retained only for bounded polling.
      for (const [id, a] of attempts) if (attempts.size >= 32 && a.status !== "waiting") attempts.delete(id);
      if (attempts.size >= 32) return { success: false, message: "Too many QQ login attempts." };
      let resolveReady!: () => void;
      const ready = new Promise<void>(resolve => { resolveReady = resolve; });
      const a: Attempt = { id: randomUUID(), owner, status: "waiting", message: "Waiting for QQ scan.", controller: new AbortController(), committed: false, stopped: false, qrGeneration: 0, ready, resolveReady, deadline: undefined as any, onDestroyed: () => finish(a, "canceled", "QQ login canceled.") };
      attempts.set(a.id, a); owner.once("destroyed", a.onDestroyed);
      a.deadline = setTimeout(() => { if (active(a)) finish(a, "expired", "QQ login expired. Please retry."); }, deps.deadlineMs ?? 5 * 60_000);
      a.deadline.unref?.();
      const startup = setTimeout(() => {
        if (a.qrDataUrl) return;
        if (active(a)) finish(a, "error", "QQ QR startup timed out. Please retry.");
        else a.resolveReady();
      }, deps.startupTimeoutMs ?? 20_000);
      try {
        a.stop = deps.startQrConnect({
          onQrDisplayed: url => {
            if (!active(a)) return;
            const generation = ++a.qrGeneration;
            void deps.renderQr(url).then(data => {
              // A synchronous success can precede local image encoding completion.
              if (attempts.get(a.id) !== a || a.owner.isDestroyed() || generation !== a.qrGeneration || !["waiting", "connected"].includes(a.status)) return;
              a.qrDataUrl = data; a.resolveReady();
            }, () => { if (active(a)) finish(a, "error", "QQ QR image could not be generated. Please retry."); });
          },
          onQrExpired: () => { if (active(a)) { a.qrGeneration++; delete a.qrDataUrl; a.message = "Refreshing QQ QR code."; } },
          onFailure: () => { if (active(a)) finish(a, "error", "QQ login failed. Check your connection and retry."); },
          onSuccess: credentials => {
            if (!active(a) || a.committed) return;
            a.committed = true;
            try {
              const config = deps.readConfig();
              a.accounts = mergeQqbotCredentials(config, credentials);
              if (!active(a)) return;
              deps.writeConfig(config);
              finish(a, "connected", "QQ Bot connected.");
              deps.restart();
            } catch { finish(a, "error", "QQ login could not be saved. Please retry."); }
          },
        }, { displayQrCodeToConsole: false, source: "cryoclaw", signal: a.controller.signal });
        if (a.status !== "waiting") stop(a);
      } catch { finish(a, "error", "QQ login is unavailable. Please retry."); }
      await a.ready; clearTimeout(startup);
      if (!a.qrDataUrl || !["waiting", "connected"].includes(a.status)) return { success: false, message: a.message };
      return { success: true, data: { attemptId: a.id, status: "waiting" as const, qrDataUrl: a.qrDataUrl, message: "Waiting for QQ scan." } };
    },
    wait(owner: QqbotOwner, id: unknown) {
      const a = owned(owner, id);
      if (!a) return { success: false, message: "QQ login attempt is unavailable." };
      if (owner.isDestroyed() && a.status === "waiting") finish(a, "canceled", "QQ login canceled.");
      return { success: true, data: view(a) };
    },
    cancel(owner: QqbotOwner, id: unknown) {
      const a = owned(owner, id); if (!a) return { success: false };
      if (a.status === "waiting") finish(a, "canceled", "QQ login canceled.");
      return { success: true };
    },
  };
}
