import type { GatewayBrowserClient } from "../gateway.ts";
import { loadGatewayModels } from "./models.ts";
import { getConfigSnapshot } from "./config.ts";
import {loadModelQuota,invalidateModelQuota} from "./model-quota.ts";

export interface LoginOption { id: string; label: string; kind: string }
export interface AuthSnapshot {
  providerCapabilities?: Array<{ provider: string; loginOptions?: LoginOption[] }>;
  providers?: Array<{ provider: string; status: string; profiles: Array<{ type: string; status: string }>;
    usage?: { plan?: string; windows: Array<{ label: string; usedPercent: number; resetAt?: number }> } }>;
  unavailable?: { message: string };
}
export interface AccountUsage { refreshing?: boolean; providers?: Array<{provider: string; plan?: string; error?: string; stale?:boolean;
  windows: Array<{label: string; usedPercent: number | null; resetAt?: number}>}> }
export interface LoginStep {
  id: string; type: string; title?: string; message?: string; externalUrl?: string;
  executor?: "client" | "gateway";
  options?: Array<{ value: unknown; label: string; hint?: string }>;
  deviceCode?: { code: string; message?: string };
  initialValue?: unknown;
}
interface WizardResult { sessionId?: string; done: boolean; status: string; step?: LoginStep; error?: string }
type Host = { client: GatewayBrowserClient | null; connected: boolean; requestUpdate(): void; loadConfiguredModels?(): Promise<void> };

export class SubscriptionAuth {
  snapshot: AuthSnapshot | null = null;
  usage: AccountUsage | null = null;
  loginCompleted = false;
  step: LoginStep | null = null;
  sessionId: string | null = null;
  busy = false;
  error = "";
  externalUrl: string | null = null;
  deviceCode: LoginStep["deviceCode"] | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private client: GatewayBrowserClient | null = null;
  private epoch = 0;
  constructor(private host: Host, private reconnectAfterLogin?: () => void) {}

  get options(): LoginOption[] {
    return this.snapshot?.providerCapabilities?.filter(c => /^(openai|openai-codex)$/.test(c.provider))
      .flatMap(c => c.loginOptions ?? []).filter(o => o.kind === "oauth" || o.kind === "device-code") ?? [];
  }
  async enableAndLogin(enable: () => Promise<void>): Promise<void> {
    if(this.busy || this.sessionId || !this.host.connected || !this.host.client)return;
    const epoch=++this.epoch;
    const current=()=>this.epoch===epoch;
    this.busy=true;this.error="";this.host.requestUpdate();
    let option:LoginOption|undefined;
    let preparedClient:GatewayBrowserClient|null=null;
    const deadline=Date.now()+120000;
    try {
      await enable();
      while(Date.now()<deadline && current()){
        const client:GatewayBrowserClient|null=this.host.client;
        if(client && this.host.connected){
          try {
            const snapshot=await client.request<AuthSnapshot>("models.authStatus",{refresh:false},{timeoutMs:5000});
            if(!current())return;
            if(this.host.client===client && this.host.connected){
              this.snapshot=snapshot;
              if(!this.options.length && preparedClient!==client){
                preparedClient=client;
                const prepared=await client.request<AuthSnapshot>("models.authStatus",{refresh:true},{timeoutMs:Math.min(65000,Math.max(1000,deadline-Date.now()))});
                if(!current())return;
                if(this.host.client!==client||!this.host.connected)continue;
                this.snapshot=prepared;
              }
              option=this.options.find(o=>o.kind==='oauth'&&!o.id.includes('token-sharing'))
                ?? this.options.find(o=>o.kind==='device-code') ?? this.options[0];
              if(option)break;
            }
          }catch { preparedClient=null; /* A provider activation can restart the gateway. */ }
        }
        if(current())await new Promise(resolve=>setTimeout(resolve,1000));
      }
      if(current() && !option)throw new Error("Account sign-in is not ready. Reconnect and try again.");
    }catch(error){if(current())this.error=error instanceof Error?error.message:String(error);}
    finally{if(current()){this.busy=false;this.host.requestUpdate();}}
    if(current() && option && !this.error)await this.start(option);
  }
  async refresh(after?: (client: GatewayBrowserClient) => Promise<unknown>, force = true): Promise<void> {
    if (this.busy || this.sessionId || !this.host.connected || !this.host.client) return;
    const client = this.host.client;
    await this.run(async current => {
      const snapshot = await client.request<AuthSnapshot>("models.authStatus", { refresh: force });
      if (current()) {
        this.snapshot = snapshot;
        const hasSubscription=snapshot.providers?.some(p=>/^(openai|openai-codex)$/.test(p.provider)
          && p.profiles?.some(profile=>['oauth','token'].includes(profile.type)));
        if(!hasSubscription)this.usage=null;
        await Promise.all([hasSubscription?this.loadUsage(client, current, force):undefined, after?.(client)]);
      }
    });
  }
  async start(option: LoginOption): Promise<void> {
    if (this.busy || this.sessionId || !this.options.some(o => o.id === option.id)) return;
    if (!this.host.connected || !this.host.client) return;
    this.client = this.host.client;
    const client = this.client;
    const sessionId = crypto.randomUUID();
    this.sessionId = sessionId;
    this.externalUrl = null;
    this.deviceCode = null;
    await this.run(async current => {
      const result = await client.request<WizardResult>("models.authLogin", { sessionId, authChoice: option.id });
      if (!current()) {
        if (result.sessionId) await client.request("wizard.cancel", { sessionId: result.sessionId, closeInput: true });
        return;
      }
      if (!result.sessionId || result.sessionId !== sessionId) throw new Error("Login returned an invalid session ID");
      this.step = null;
    });
    if (this.client !== client || this.sessionId !== sessionId) return;
    if (this.error) this.sessionId = null;
    else if (this.sessionId) await this.next();
  }
  async next(value?: unknown, submitAnswer = true): Promise<void> {
    if (this.busy || !this.sessionId || !this.client) return;
    if (this.client !== this.host.client || !this.host.connected) { await this.cancel(); return; }
    const client = this.client;
    const sessionId = this.sessionId;
    const step = this.step;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    await this.run(async current => {
      let answer = step && submitAnswer && step.type !== "progress" && step.executor !== "gateway"
        ? {stepId:step.id, ...(step.type === "note" ? {} : {value})} : undefined;
      for (;;) {
      const result = await client.request<WizardResult>("wizard.next", {
        sessionId, ...(answer ? { answer } : {}),
      }, { timeoutMs: 15 * 60_000 });
      if (!current()) return;
      this.error = result.error ?? "";
      this.step = result.step ?? null;
      if (this.step?.externalUrl) this.externalUrl = safeOpenAIAuthUrl(this.step.externalUrl);
      if (this.step?.deviceCode) this.deviceCode = this.step.deviceCode;
      this.host.requestUpdate();
      if (result.done) {
        this.sessionId = null;
        this.step = null;
        if (result.status !== "done") throw new Error(result.error ?? result.status);
        this.loginCompleted = true;
        await client.request("models.authRefresh", {operation:"login"});
        invalidateModelQuota(client);
        const snapshot = await client.request<AuthSnapshot>("models.authStatus", { refresh: true });
        if (current()) this.snapshot = snapshot;
        // The first native login can move shared auth from the legacy agent DB
        // into the state DB while catalog workers retain the old owner. A fresh
        // gateway generation reopens the committed owner without another login.
        if (current() && !snapshot.providers?.some(p => /^(openai|openai-codex)$/.test(p.provider)
          && p.profiles?.some(profile => ["oauth","token"].includes(profile.type))) && this.reconnectAfterLogin) {
          this.reconnectAfterLogin();
          return;
        }
        if (current()) await this.loadUsage(client, current);
        if (current() && this.host.loadConfiguredModels) {
          await Promise.all([loadGatewayModels(client, {force:true}), getConfigSnapshot(client, {force:true})]);
          if (current()) await this.host.loadConfiguredModels();
        }
        return;
      }
      if (this.step?.type === "note") answer = {stepId:this.step.id};
      else if (this.step?.type === "progress" || this.step?.executor === "gateway") answer = undefined;
      else return;
      }
    });
    // Browser callbacks can complete a text prompt without a pasted redirect.
    // Poll without submitting an empty answer, preserving the user's draft.
    if (!this.error && this.sessionId === sessionId && this.step?.type === "text" && this.externalUrl) {
      this.pollTimer = setTimeout(() => { this.pollTimer = null; void this.next(undefined, false); }, 1500);
    }
  }
  private async loadUsage(client: GatewayBrowserClient, current: () => boolean, force = true): Promise<void> {
    try {
      const quota = await loadModelQuota(client,"openai-codex",force);
      if (current()) this.usage = {providers:[{provider:"openai",windows:quota.windows,plan:quota.plan,error:quota.error,stale:quota.stale}]};
    } catch {
      // Account state remains usable when the upstream quota service is offline.
      if (current()) this.usage = null;
    }
  }
  async cancel(): Promise<void> {
    const client = this.client;
    const sessionId = this.sessionId;
    const epoch = ++this.epoch;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.busy = false;
    this.step = null;
    this.sessionId = null;
    this.externalUrl = null;
    this.deviceCode = null;
    this.host.requestUpdate();
    if (client && sessionId) {
      try { await client.request("wizard.cancel", { sessionId, closeInput: true }); }
      catch (error) {
        if (this.epoch === epoch) { this.error = String(error); this.host.requestUpdate(); }
      }
    }
  }
  private async run(action: (current: () => boolean) => Promise<void>): Promise<void> {
    const epoch = ++this.epoch;
    const client = this.host.client;
    this.busy = true;
    this.error = "";
    this.host.requestUpdate();
    try { await action(() => epoch === this.epoch && this.host.client === client && this.host.connected); }
    catch (error) { if (epoch === this.epoch) this.error = error instanceof Error ? error.message : String(error); }
    finally {
      if (epoch === this.epoch) {
        if (this.host.client !== client || !this.host.connected) {
          this.snapshot = null; this.sessionId = null; this.step = null;
        }
        this.busy = false;
        this.host.requestUpdate();
      }
    }
  }
}

export function safeOpenAIAuthUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && ["auth.openai.com", "chatgpt.com"].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}
