import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { renderOpenAIProxy } from "./openai-proxy.ts";
import { renderSubscriptionModels } from "./subscription-models.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { getLocale } from "../../i18n.ts";
import { SubscriptionAuth, safeOpenAIAuthUrl } from "../../controllers/subscription-auth.ts";
import { openExternal, restartGateway } from "../../data/ipc-bridge.ts";
import { loadGatewayModels } from "../../controllers/models.ts";
import { getConfigSnapshot, patchConfig } from "../../controllers/config.ts";

const accounts = new WeakMap<AppViewState, SubscriptionAuth>();
const answers = new WeakMap<SubscriptionAuth, unknown>();
const bindings = new WeakMap<SubscriptionAuth, (element: Element | undefined) => void>();
const initializedClients = new WeakMap<SubscriptionAuth, AppViewState["client"]>();
const expandedAccounts = new WeakMap<AppViewState, boolean>();

export function renderSubscriptionAccount(host: AppViewState) {
  let account = accounts.get(host);
  if (!account) { account = new SubscriptionAuth(host, restartGateway); accounts.set(host, account); }
  const auth = account;
  if (host.connected && host.client && !auth.busy && !auth.sessionId && initializedClients.get(auth) !== host.client) {
    initializedClients.set(auth, host.client);
    queueMicrotask(() => void sync());
  }
  let bind = bindings.get(auth);
  if (!bind) {
    let container: Element | undefined;
    bind = element => {
      if (element) container = element;
      else queueMicrotask(() => {
        if (!container?.isConnected) {
          answers.delete(auth);
          initializedClients.delete(auth);
          if (auth.sessionId || auth.busy) void auth.cancel();
        }
      });
    };
    bindings.set(auth, bind);
  }
  const zh = getLocale().startsWith("zh");
  const label = (cn: string, en: string) => zh ? cn : en;
  const step = auth.step;
  const url = auth.externalUrl ?? (step?.externalUrl ? safeOpenAIAuthUrl(step.externalUrl) : null);
  const deviceCode = auth.deviceCode ?? step?.deviceCode;
  const interactive = step && !["note", "progress"].includes(step.type) && step.executor !== "gateway";
  const advance = async (value?: unknown) => {
    await auth.next(value);
    answers.delete(auth);
    host.requestUpdate();
    if (!auth.sessionId && !auth.error && host.client) {
      await Promise.all([loadGatewayModels(host.client, { force: true }), getConfigSnapshot(host.client, { force: true })]);
      await host.loadConfiguredModels();
      host.requestUpdate();
    }
  };
  const providers = auth.snapshot?.providers?.filter(p => /^(openai|openai-codex)$/.test(p.provider)) ?? [];
  const signedIn = providers.some(p => p.profiles?.some(profile => ["oauth","token"].includes(profile.type) && ["ok","expiring","static"].includes(profile.status)));
  const usage = auth.usage?.providers?.find(p => /^(openai|openai-codex)$/.test(p.provider));
  const windows = usage?.windows ?? providers.find(p=>p.usage)?.usage?.windows ?? [];
  const plan = usage?.plan ?? providers.find(p=>p.usage?.plan)?.usage?.plan;
  const sync = async () => {
    await auth.refresh(async client => {
      await Promise.all([loadGatewayModels(client, { force: true }), getConfigSnapshot(client, { force: true })]);
      await host.loadConfiguredModels();
    });
  };
  const enable = async () => {
    if (!host.client || auth.busy) return;
    auth.busy = true;
    auth.error = "";
    host.requestUpdate();
    try {
      // Enabling may immediately follow a proxy-triggered reconnect. Ignore a
      // negative cached snapshot and wait briefly for the new connection.
      let snapshot = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        if (host.connected && host.client) snapshot = await getConfigSnapshot(host.client, {force:true});
        if (snapshot) break;
        await new Promise(resolve => setTimeout(resolve, 750));
      }
      if (!snapshot || !host.client) throw new Error(label("网关仍在重连，请稍后重试。", "The gateway is reconnecting. Try again shortly."));
      const result = await patchConfig(host.client, (draft: Record<string, any>) => {
        const plugins = draft.plugins ??= {};
        if (Array.isArray(plugins.allow) && !plugins.allow.includes("openai")) plugins.allow.push("openai");
        ((plugins.entries ??= {}).openai ??= {}).enabled = true;
      });
      if (!result.ok) throw new Error(result.error ?? "Could not enable OpenAI");
      auth.snapshot = null;
      // A plugin enable can restart the gateway. Refresh automatically once its
      // native login capabilities become available; no page reload is needed.
      for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (!host.connected || !host.client) continue;
        try {
          const status = await host.client.request<import("../../controllers/subscription-auth.ts").AuthSnapshot>("models.authStatus", {refresh:true});
          if (status.providerCapabilities?.some(provider => provider.provider === "openai" && provider.loginOptions?.length)) {
            auth.snapshot = status;
            break;
          }
        } catch { /* the gateway may still be finishing its restart */ }
      }
      if (!auth.snapshot) throw new Error(label("启用设置已保存，但网关尚未就绪。连接恢复后点击同步即可，无需刷新页面。", "The setting was saved, but the gateway is not ready yet. Sync after reconnection; no page reload is needed."));
    } catch (error) { auth.error = error instanceof Error ? error.message : String(error); }
    finally { auth.busy = false; host.requestUpdate(); }
  };
  return html`<details ${ref(bind)} class="oc-subscription-account" aria-busy=${auth.busy}
    .open=${expandedAccounts.get(host) ?? (!signedIn || !!auth.sessionId)}
    @toggle=${(event:Event)=>{if(event.target===event.currentTarget)expandedAccounts.set(host,(event.target as HTMLDetailsElement).open);}}>
    <summary class="oc-subscription-account__summary"><strong>${label("ChatGPT / Codex 订阅账户", "ChatGPT / Codex subscription")}</strong>
      <span class="cc-tag ${signedIn?"cc-tag--success":""}">${signedIn?label("已连接", "Connected"):label("连接账户", "Connect account")}</span>${plan?html`<span class="oc-settings__hint">${plan}</span>`:nothing}</summary>
    <div class="oc-subscription-account__content">
    <div class="oc-provider-header">
      <div>
      <p class="oc-settings__hint">${label("使用 ChatGPT 订阅登录，查看模型与账户用量。订阅额度与 API 余额分别计算。", "Sign in with your ChatGPT subscription to view models and usage. Subscription limits are separate from API billing.")}</p></div>
      <button class="btn" ?disabled=${auth.busy || !!auth.sessionId || !host.connected}
        @click=${() => void sync()}>${label("同步账户、模型与额度", "Sync account, models and limits")}</button>
    </div>
    ${auth.snapshot?.unavailable ? html`<p role="status">${auth.snapshot.unavailable.message}</p>` : nothing}
    ${auth.busy && !auth.sessionId ? html`<p class="oc-settings__hint" role="status">${label("正在连接并同步账户，请稍候…", "Connecting and syncing your account…")}</p>` : nothing}
    <div class="oc-subscription-account__overview" role="status" aria-live="polite">
      <div><span class="cc-tag ${signedIn ? "cc-tag--success" : ""}">${signedIn ? label("已连接", "Connected") : auth.loginCompleted ? label("授权已保存，正在确认连接", "Sign-in saved, checking connection") : providers.some(p=>p.status==="expired") ? label("登录已过期", "Sign-in expired") : label("尚未连接账户", "Not signed in")}</span>
        ${plan ? html`<strong>${plan.toLowerCase() === "plus" ? "ChatGPT Plus" : plan}</strong>` : nothing}</div>
      <p class="oc-settings__hint">${signedIn ? label("账户已就绪，可在下方配置模型，也可在聊天和任务中切换模型。", "Your account is ready. Configure models below or switch models in chat and tasks.") : auth.loginCompleted ? label("授权已完成，但内核尚未返回可用账户。请同步账户；若仍未恢复，请重连网关。", "Authorization completed, but the gateway has not confirmed account access. Sync your account; reconnect the gateway if it persists.") : label("登录后，这里会显示连接状态和订阅额度。", "Connection status and subscription limits appear here after sign-in.")}</p>
    </div>
    <details class="oc-subscription-account__signin" .open=${!signedIn || !!auth.sessionId}><summary>${signedIn ? label("重新登录或切换账户", "Sign in again or switch account") : label("连接 ChatGPT 账户", "Connect your ChatGPT account")}</summary>
    <div class="btn-row">${auth.options.map(option => html`<button class=${option.kind === "oauth" && !option.id.includes("token-sharing") ? "btn primary" : "btn"}
      ?disabled=${auth.busy || !!auth.sessionId || !host.connected}
      @click=${() => void auth.start(option)}>${option.kind === "device-code" ? label("使用设备码登录", "Sign in with a device code") : option.id.includes("token-sharing") ? label("高级：共享账户登录", "Advanced: shared-account sign-in") : label("在浏览器中登录", "Sign in with your browser")}</button>`)}</div>
    ${auth.snapshot && !auth.options.length && !auth.snapshot.unavailable ? html`<div>
      <p class="oc-settings__hint">${label("内核尚未提供 OpenAI 登录方式。启用内置提供商后，等待网关重新连接并再次同步。", "The gateway has not exposed OpenAI sign-in. Enable the bundled provider, wait for reconnection, then sync again.")}</p>
      <button class="btn" ?disabled=${auth.busy || !host.connected} @click=${() => void enable()}>${label("启用 OpenAI 账户登录", "Enable OpenAI account sign-in")}</button>
    </div>` : nothing}
    ${!auth.snapshot && !auth.busy ? html`<p class="oc-settings__hint">${label("连接恢复后将自动检查登录方式，也可点击上方按钮重新同步。", "Sign-in options load automatically after connection. Use the button above to sync again.")}</p>` : nothing}
    </details>
    ${signedIn || auth.loginCompleted ? html`<div class="oc-subscription-account__status">
      <strong>${label("订阅额度", "Subscription limits")}</strong>
      ${windows.map(window => html`<div class="oc-subscription-account__window">
        <span>${label(window.label === "5h" ? "5 小时额度" : window.label === "Week" ? "每周额度" : window.label, window.label)}</span><span>${typeof window.usedPercent==="number" && Number.isFinite(window.usedPercent) ? `${Math.max(0, Math.min(100, 100 - window.usedPercent)).toFixed(0)}% ${label("剩余", "remaining")}` : label("额度未知", "Limit unavailable")}</span>
        ${typeof window.usedPercent==="number" && Number.isFinite(window.usedPercent) ? html`<progress max="100" value=${Math.max(0,Math.min(100,100-window.usedPercent))} aria-label=${`${window.label} ${label("剩余额度", "remaining")}`}></progress>` : nothing}
        ${window.resetAt ? html`<span>${label("重置", "Resets")} ${new Date(window.resetAt).toLocaleString()}</span>` : nothing}
      </div>`)}
      ${usage?.stale ? html`<p class="oc-settings__hint" role="status">${label("额度暂时无法更新，当前显示上次成功查询的数据。", "Limits could not be refreshed. Showing the last successful result.")}</p>` : nothing}
      ${!windows.length ? html`<p class="oc-settings__hint">${usage?.error || (auth.usage?.refreshing ? label("额度正在查询中，请稍后同步。", "Limits are loading. Sync again shortly.") : label("服务尚未返回额度数据。点击上方同步重试，不代表额度为零。", "The service has not returned usage limits. Sync above to retry; this does not mean your balance is zero."))}</p>` : nothing}
    </div>` : nothing}
    ${auth.sessionId ? html`<div class="oc-subscription-account__flow">
      ${step ? html`<strong>${deviceCode ? label("在浏览器输入登录码", "Enter the code in your browser") : url ? label("在浏览器完成账户授权", "Complete sign-in in your browser") : label("正在准备登录…", "Preparing sign-in…")}</strong>
        <p class="oc-subscription-account__message">${deviceCode ? label("打开下方官方登录页面，输入这组代码。完成后此页面会自动更新。", "Open the official sign-in page below and enter this code. This view updates automatically when you finish.") : url ? label("① 打开下方官方登录页面。② 完成账户授权。③ 将浏览器地址栏里最后的完整地址粘贴到下方并提交；若此页面已自动完成，则无需粘贴。", "1. Open the official sign-in page. 2. Authorize your account. 3. Paste the final full browser address below and submit it, unless sign-in has already completed automatically.") : label("正在连接登录服务，无需点击继续。你可以随时取消。", "Connecting to the sign-in service. No action is needed; you can cancel at any time.")}</p>
        ${deviceCode ? html`<p class="oc-subscription-account__code"><code>${deviceCode.code}</code></p>` : nothing}
        ${url ? html`<button class="btn" @click=${() => void openExternal(url).catch(error => { auth.error = String(error); host.requestUpdate(); })}>${label("打开官方登录页面", "Open official sign-in page")}</button>` : nothing}
        ${step.type === "text" ? html`<label class="oc-subscription-account__message">${label("未自动完成时：粘贴浏览器最后的跳转地址", "If sign-in does not complete: paste the final redirect URL")}<input class="oc-settings__input" type="password" autocomplete="off"
          .value=${typeof answers.get(auth) === "string" ? answers.get(auth) : ""}
          aria-label=${step.message ?? label("授权码", "Authorization code")}
          @input=${(event: Event) => answers.set(auth, (event.target as HTMLInputElement).value)} /></label>` : nothing}
        ${step.type === "select" || step.type === "multiselect" ? html`<select class="oc-settings__select"
          ?multiple=${step.type === "multiselect"} aria-label=${step.message ?? "Selection"}
          @change=${(event: Event) => {
            const element = event.target as HTMLSelectElement;
            const values = Array.from(element.selectedOptions).map(o => step.options?.[Number(o.value)]?.value);
            answers.set(auth, step.type === "multiselect" ? values : values[0]);
          }}>${step.options?.map((option, index) => {
            const value = answers.get(auth) ?? step.initialValue;
            const selected = step.type === "multiselect" ? Array.isArray(value) && value.includes(option.value)
              : value === undefined ? index === 0 : value === option.value;
            return html`<option value=${index} ?selected=${selected}>${option.label}</option>`;
          })}</select>` : nothing}
        ${step.type === "confirm" ? html`<button class="btn" ?disabled=${auth.busy} @click=${() => void advance(false)}>${label("否", "No")}</button>` : nothing}
        ${interactive ? html`<button class="btn primary" ?disabled=${auth.busy} @click=${() => void advance(
          step.type === "confirm" ? true : answers.get(auth) ?? step.initialValue ?? (step.type === "select" ? step.options?.[0]?.value : step.type === "multiselect" ? [] : "")
        )}>${step.type === "text" ? label("提交跳转地址", "Submit redirect URL") : label("确认选择", "Confirm selection")}</button>` : nothing}
        ${step.message ? html`<details class="oc-subscription-account__message"><summary>${label("查看原始提示", "Show technical details")}</summary><p>${step.message}</p></details>` : nothing}` : html`<p role="status">${label("正在准备安全登录…", "Preparing secure sign-in…")}</p>`}
      <button class="btn" @click=${() => { answers.delete(auth); void auth.cancel(); }}>${label("取消登录", "Cancel sign-in")}</button>
    </div>` : nothing}
    ${auth.error ? html`<p class="oc-text-danger" role="alert">${auth.error}</p>` : nothing}
    ${auth.snapshot ? renderSubscriptionModels(host, signedIn) : nothing}
    ${renderOpenAIProxy(host, !!auth.sessionId || auth.busy)}
  </div></details>`;
}
