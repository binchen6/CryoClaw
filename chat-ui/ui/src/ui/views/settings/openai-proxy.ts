import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { openaiProxy, type OpenAIProxyConfig } from "../../data/ipc-bridge.ts";
import { getLocale } from "../../i18n.ts";
type State = { config: OpenAIProxyConfig; busy: boolean; ready: boolean; error: string; notice: string };
const states = new WeakMap<AppViewState, State>();
export function renderOpenAIProxy(host: AppViewState, loginActive: boolean) {
  let state = states.get(host);
  if (!state) {
    state = {config:{mode:"system",url:""},busy:true,ready:false,error:"",notice:""};
    states.set(host,state);
    const initial = state;
    void openaiProxy("get").then(config => {initial.config=config; initial.ready=true;})
      .catch(error => {initial.error=String(error);}).finally(() => {initial.busy=false;host.requestUpdate();});
  }
  const s = state;
  const text = (zh: string, en: string) => getLocale().startsWith("zh") ? zh : en;
  const run = async (action: "save" | "test") => {
    if (s.busy || loginActive) return;
    s.busy=true;s.error="";s.notice="";host.requestUpdate();
    try {
      const result = await openaiProxy(action, {...s.config});
      if (action === "save") s.config=result;
      s.notice=action === "save" ? text("已保存，网关正在重连。连接恢复后可重新登录或同步账户。", "Saved. The gateway is reconnecting; sign in or sync after reconnection.")
        : text("代理隧道连接成功；此测试不代表账户登录或地区可用性已通过。", "Proxy tunnel connected. This does not verify account sign-in or regional availability.");
    } catch (error) {s.error=error instanceof Error ? error.message : String(error);}
    finally {s.busy=false;host.requestUpdate();}
  };
  return html`<details class="oc-openai-proxy-details"><summary>${text("OpenAI / Codex 独立代理", "OpenAI / Codex proxy")}<span class="oc-settings__hint">${s.config.mode === "custom" ? text("自定义代理", "Custom proxy") : s.config.mode === "direct" ? text("直接连接", "Direct") : text("跟随环境", "Environment")}</span></summary>
    <fieldset class="oc-openai-proxy" ?disabled=${s.busy || loginActive || !s.ready} aria-busy=${s.busy}>
    <legend>${text("OpenAI / Codex 独立代理", "OpenAI / Codex proxy")}</legend>
    <p class="oc-settings__hint">${text("用于应用内登录、额度查询和模型 HTTP 请求，仅影响 OpenAI / ChatGPT 官方服务。浏览器登录页仍使用浏览器自己的网络设置。", "Routes in-app sign-in, limits and model HTTP requests for official OpenAI / ChatGPT services. Browser sign-in pages use the browser’s network settings.")}</p>
    <label>${text("连接方式", "Connection")}<select class="oc-settings__select" .value=${s.config.mode}
      @change=${(event:Event) => {s.config={...s.config,mode:(event.target as HTMLSelectElement).value as OpenAIProxyConfig["mode"]};s.notice="";s.error="";host.requestUpdate();}}>
      <option value="system">${text("跟随环境设置", "Use environment settings")}</option>
      <option value="direct">${text("直接连接", "Direct connection")}</option>
      <option value="custom">${text("自定义 HTTP(S) 代理", "Custom HTTP(S) proxy")}</option>
    </select></label>
    ${s.config.mode === "custom" ? html`<label>${text("代理地址", "Proxy URL")}<input class="oc-settings__input" type="url" spellcheck="false" autocomplete="off" placeholder="http://127.0.0.1:7890" .value=${s.config.url}
      @input=${(event:Event) => {s.config.url=(event.target as HTMLInputElement).value;s.notice="";}} /></label>
      <p class="oc-settings__hint">${text("支持 HTTP CONNECT，不支持 SOCKS 或含账号密码的地址。", "Supports HTTP CONNECT; SOCKS and URLs containing credentials are not supported.")}</p>` : nothing}
    <div class="btn-row"><button class="btn primary" @click=${() => void run("save")}>${text("保存并重连", "Save and reconnect")}</button>
      ${s.config.mode === "custom" ? html`<button class="btn" @click=${() => void run("test")}>${text("测试代理连接", "Test proxy connection")}</button>` : nothing}</div>
    ${loginActive ? html`<p class="oc-settings__hint">${text("请完成或取消当前登录后再修改代理。", "Finish or cancel sign-in before changing the proxy.")}</p>` : nothing}
    ${s.error ? html`<p class="oc-text-danger" role="alert">${s.error}</p>` : nothing}
    ${s.notice ? html`<p role="status">${s.notice}</p>` : nothing}
  </fieldset></details>`;
}
