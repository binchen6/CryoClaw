/**
 * Settings: MCP & Hooks Tab（R60）。
 *
 * MCP 服务器管理 openclaw.json 的 `mcp.servers`（stdio / SSE / streamable-http
 * 三形态；timeouts、oauth、toolFilter 等高级字段不在本表单出现，编辑时经
 * preserve 原样保留）。Webhooks 管理 `hooks` 段（开关 + path/token +
 * defaultSessionKey + mappings 列表；gmail/internal/presets 等子段不触碰）。
 * 读写都走内核 config.get/config.patch（脱敏快照可安全参与 patch，REDACTED
 * 哨兵由内核写侧还原）；mappings 删条目由 patchConfig 的 replacePaths 自动
 * 探测整体替换。
 */
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { AppViewState } from "../../app-view-state.ts";
import { t, tWithDetail } from "../../i18n.ts";
import { getConfigSnapshot } from "../../controllers/config.ts";
import { runConfigPatch } from "./tab-patch.ts";
import { showConfirm } from "../confirm-dialog.ts";
import {
  applyHooksToDraft,
  draftFromServer,
  hooksFromConfig,
  listMcpServers,
  removeMcpServerInDraft,
  serverFromDraft,
  upsertMcpServerInDraft,
  validateHooks,
  type HookMappingDraft,
  type HooksState,
  type McpServerDraft,
  type McpServerEntry,
} from "./tab-mcp-hooks.lib.ts";
import { generateUUID } from "../../uuid.ts";

type TabState = {
  initialized: boolean;
  wasConnected: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  successMsg: string | null;
  hint: string | null;
  // 编辑中的服务器（原快照条目，供 preserve 高级字段）；null = 新增
  editingServer: McpServerEntry | null;
  serverDraft: McpServerDraft | null;
  servers: McpServerEntry[];
  hooks: HooksState | null;
};

const s: TabState = {
  initialized: false,
  wasConnected: false,
  loading: false,
  saving: false,
  error: null,
  successMsg: null,
  hint: null,
  editingServer: null,
  serverDraft: null,
  servers: [],
  hooks: null,
};

function emptyServerDraft(): McpServerDraft {
  return {
    name: "",
    enabled: true,
    transport: "stdio",
    command: "",
    argsText: "",
    envText: "",
    cwd: "",
    url: "",
    headersText: "",
  };
}

async function refresh(state: AppViewState) {
  const client = state.client;
  if (!state.connected || !client) return;
  s.loading = true;
  s.error = null;
  state.requestUpdate();
  try {
    const snap = await getConfigSnapshot(client, { force: true });
    if (snap) {
      s.servers = listMcpServers(snap.config);
      s.hooks = hooksFromConfig(snap.config);
    } else {
      s.error = t("settings.mcpHooks.loadFailed");
    }
  } catch {
    s.error = t("settings.mcpHooks.loadFailed");
  } finally {
    s.loading = false;
    state.requestUpdate();
  }
}

async function init(state: AppViewState) {
  if (s.initialized || s.loading || !state.connected) return;
  s.initialized = true;
  await refresh(state);
}

export function resetMcpHooksTab() {
  s.initialized = false;
  s.wasConnected = false;
  s.loading = false;
  s.saving = false;
  s.error = null;
  s.successMsg = null;
  s.hint = null;
  s.editingServer = null;
  s.serverDraft = null;
  s.servers = [];
  s.hooks = null;
}

/* ── server form actions ── */

function startAddServer(state: AppViewState) {
  s.editingServer = null;
  s.serverDraft = emptyServerDraft();
  state.requestUpdate();
}

function startEditServer(state: AppViewState, entry: McpServerEntry) {
  s.editingServer = entry;
  s.serverDraft = draftFromServer(entry);
  state.requestUpdate();
}

function cancelServerForm(state: AppViewState) {
  s.editingServer = null;
  s.serverDraft = null;
  state.requestUpdate();
}

async function saveServer(state: AppViewState) {
  if (!s.serverDraft || s.saving) return;
  const validated = serverFromDraft(s.serverDraft);
  if (!validated.ok) {
    s.error = t(`settings.mcpHooks.error.${validated.error}`);
    state.requestUpdate();
    return;
  }
  s.saving = true;
  s.error = null;
  s.successMsg = null;
  s.hint = null;
  state.requestUpdate();
  try {
    const name = s.serverDraft.name.trim();
    // 重名守卫：同名会在 applyMcpServersToDraft 中被后写者静默覆盖（数据丢失）
    const nameTaken = s.servers.some(
      (e) => e.name === name && (!s.editingServer || e.name !== s.editingServer.name),
    );
    if (nameTaken) {
      s.saving = false;
      s.error = t("settings.mcpHooks.error.nameDuplicate");
      state.requestUpdate();
      return;
    }
    // 编辑改名：先写新名字，再把旧名字置 null（两次单条目操作，不整集合重写——
    // R60 审查 P2：陈旧本地集合的全量替换会在 baseHash 冲突重试时删掉并发新增）
    const editing = s.editingServer;
    const preserve = editing && editing.name === name ? editing.server : undefined;
    const outcome = await runConfigPatch(state, (draft) => {
      upsertMcpServerInDraft(draft, name, validated.server, preserve);
      if (editing && editing.name !== name) {
        removeMcpServerInDraft(draft, editing.name);
      }
    }, { replacePaths: [] });
    if (!outcome.ok) {
      s.saving = false;
      s.error = tWithDetail("settings.error.saveFailed", outcome.error);
      state.requestUpdate();
      return;
    }
    await refresh(state);
    s.saving = false;
    s.editingServer = null;
    s.serverDraft = null;
    s.successMsg = t("settings.saved");
    s.hint = outcome.hint ?? null;
    state.requestUpdate();
  } catch (e) {
    s.saving = false;
    s.error = tWithDetail("settings.error.saveFailed", e instanceof Error ? e.message : String(e));
    state.requestUpdate();
  }
}

async function deleteServer(state: AppViewState, name: string) {
  if (s.saving) return;
  const confirmed = await showConfirm(
    state,
    t("settings.mcpHooks.deleteServerConfirm"),
    { danger: true },
  );
  if (!confirmed) return;
  s.saving = true;
  s.error = null;
  state.requestUpdate();
  try {
    // 单条目删除（R60 审查 P2）：只 touch 目标名字，不做基于陈旧本地集合的全量替换
    const outcome = await runConfigPatch(state, (draft) => {
      removeMcpServerInDraft(draft, name);
    });
    if (!outcome.ok) {
      s.saving = false;
      s.error = tWithDetail("settings.error.saveFailed", outcome.error);
      state.requestUpdate();
      return;
    }
    // R60 审查 P3：删除的正是正在编辑的条目时关闭表单，防止随后 Save 把已删条目写回
    if (s.editingServer?.name === name) {
      s.editingServer = null;
      s.serverDraft = null;
    }
    await refresh(state);
    s.saving = false;
    s.successMsg = t("settings.saved");
    s.hint = outcome.hint ?? null;
    state.requestUpdate();
  } catch (e) {
    s.saving = false;
    s.error = tWithDetail("settings.error.saveFailed", e instanceof Error ? e.message : String(e));
    state.requestUpdate();
  }
}

/* ── hooks actions ── */

function newMappingDraft(): HookMappingDraft {
  return {
    id: `mapping-${generateUUID().slice(0, 8)}`,
    matchPath: "",
    matchSource: "",
    action: "agent",
    name: "",
    sessionKey: "",
    sessionMode: "isolated",
    messageTemplate: "",
  };
}

async function saveHooks(state: AppViewState) {
  if (!s.hooks || s.saving) return;
  // 保存前校验（R60 审查 P2）：agent+persistent 无会话锚点的规则会被内核
  // superRefine 拒绝、被 applyHooksToDraft 静默省略 sessionMode——先拦下提示用户
  const validationError = validateHooks(s.hooks);
  if (validationError) {
    s.error = t(`settings.mcpHooks.error.${validationError}`);
    state.requestUpdate();
    return;
  }
  s.saving = true;
  s.error = null;
  s.successMsg = null;
  s.hint = null;
  state.requestUpdate();
  try {
    // 快照表单状态（R60 审查 P3）：mutator 在 patchConfig 内 await 快照后才执行，
    // 活引用会让在途期间的新输入被无声并入本次补丁
    const hooks = structuredClone(s.hooks);
    const outcome = await runConfigPatch(state, (draft) => {
      applyHooksToDraft(draft, hooks);
    }, { replacePaths: ["hooks.mappings"] });
    if (!outcome.ok) {
      s.saving = false;
      s.error = tWithDetail("settings.error.saveFailed", outcome.error);
      state.requestUpdate();
      return;
    }
    await refresh(state);
    s.saving = false;
    s.successMsg = t("settings.saved");
    s.hint = outcome.hint ?? null;
    state.requestUpdate();
  } catch (e) {
    s.saving = false;
    s.error = tWithDetail("settings.error.saveFailed", e instanceof Error ? e.message : String(e));
    state.requestUpdate();
  }
}

/* ── render helpers ── */

function renderServerRow(state: AppViewState, entry: McpServerEntry) {
  const server = entry.server;
  const transport = typeof server.transport === "string" ? server.transport : "stdio";
  const target = transport === "stdio"
    ? String(server.command ?? "")
    : String(server.url ?? "");
  const enabled = server.enabled !== false;
  return html`
    <div class="oc-mcp__row">
      <div class="oc-mcp__row-main">
        <div class="oc-mcp__row-head">
          <span class="oc-mcp__name">${entry.name}</span>
          <span class="oc-mcp__badge oc-mcp__badge--${enabled ? "on" : "off"}">
            ${t(enabled ? "settings.mcpHooks.enabled" : "settings.mcpHooks.disabled")}
          </span>
          <span class="oc-mcp__transport">${transport}</span>
        </div>
        <div class="oc-mcp__detail" title=${target}>${target}</div>
      </div>
      <div class="oc-mcp__row-side">
        <button
          class="oc-settings__btn oc-settings__btn--secondary oc-settings__btn--compact"
          @click=${() => startEditServer(state, entry)}
        >${t("settings.mcpHooks.editAction")}</button>
        <button
          class="oc-settings__btn oc-settings__btn--danger oc-settings__btn--compact"
          ?disabled=${s.saving}
          @click=${() => deleteServer(state, entry.name)}
        >${t("settings.mcpHooks.deleteAction")}</button>
      </div>
    </div>
  `;
}

function renderServerForm(state: AppViewState) {
  const d = s.serverDraft;
  if (!d) return nothing;
  const isHttp = d.transport !== "stdio";
  return html`
    <div class="oc-settings__card oc-mcp__form">
      <div class="oc-settings__card-title">
        ${t(s.editingServer ? "settings.mcpHooks.editServer" : "settings.mcpHooks.addServer")}
      </div>
      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.mcpHooks.serverName")} *</label>
        <input class="oc-settings__input" .value=${d.name} ?disabled=${!!s.editingServer}
          placeholder="my-server"
          @input=${(e: Event) => { d.name = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
        <div class="oc-settings__field-hint">${t("settings.mcpHooks.serverNameHint")}</div>
      </div>
      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.mcpHooks.transport")}</label>
        <select class="oc-settings__input" .value=${d.transport}
          @change=${(e: Event) => { d.transport = (e.target as HTMLSelectElement).value as McpServerDraft["transport"]; state.requestUpdate(); }}>
          <option value="stdio">stdio</option>
          <option value="sse">sse</option>
          <option value="streamable-http">streamable-http</option>
        </select>
      </div>
      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.mcpHooks.enableServer")}</label>
        <oc-toggle-switch .checked=${d.enabled}
          @change=${(e: CustomEvent) => { d.enabled = e.detail.checked; state.requestUpdate(); }}
        ></oc-toggle-switch>
      </div>
      ${isHttp
        ? html`
          <div class="oc-settings__form-group">
            <label class="oc-settings__label">${t("settings.mcpHooks.url")} *</label>
            <input class="oc-settings__input" .value=${d.url} placeholder="https://mcp.example.com/mcp"
              @input=${(e: Event) => { d.url = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
          </div>
          <div class="oc-settings__form-group">
            <label class="oc-settings__label">${t("settings.mcpHooks.headers")}</label>
            <textarea class="oc-settings__input" rows="3" .value=${d.headersText}
              placeholder="Authorization: Bearer token"
              @input=${(e: Event) => { d.headersText = (e.target as HTMLTextAreaElement).value; state.requestUpdate(); }}></textarea>
            <div class="oc-settings__field-hint">${t("settings.mcpHooks.headersHint")}</div>
          </div>
        `
        : html`
          <div class="oc-settings__form-group">
            <label class="oc-settings__label">${t("settings.mcpHooks.command")} *</label>
            <input class="oc-settings__input" .value=${d.command} placeholder="npx"
              @input=${(e: Event) => { d.command = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
          </div>
          <div class="oc-settings__form-group">
            <label class="oc-settings__label">${t("settings.mcpHooks.args")}</label>
            <textarea class="oc-settings__input" rows="3" .value=${d.argsText}
              placeholder="-y\n@modelcontextprotocol/server-filesystem"
              @input=${(e: Event) => { d.argsText = (e.target as HTMLTextAreaElement).value; state.requestUpdate(); }}></textarea>
            <div class="oc-settings__field-hint">${t("settings.mcpHooks.argsHint")}</div>
          </div>
          <div class="oc-settings__form-group">
            <label class="oc-settings__label">${t("settings.mcpHooks.env")}</label>
            <textarea class="oc-settings__input" rows="3" .value=${d.envText}
              placeholder="API_KEY=value"
              @input=${(e: Event) => { d.envText = (e.target as HTMLTextAreaElement).value; state.requestUpdate(); }}></textarea>
            <div class="oc-settings__field-hint">${t("settings.mcpHooks.envHint")}</div>
          </div>
          <div class="oc-settings__form-group">
            <label class="oc-settings__label">${t("settings.mcpHooks.cwd")}</label>
            <input class="oc-settings__input" .value=${d.cwd}
              @input=${(e: Event) => { d.cwd = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
          </div>
        `}

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
      <div class="oc-settings__btn-row">
        <button class="oc-settings__btn oc-settings__btn--secondary" ?disabled=${s.saving}
          @click=${() => cancelServerForm(state)}>${t("settings.cancel")}</button>
        <button class="oc-settings__btn oc-settings__btn--primary" ?disabled=${s.saving}
          @click=${() => saveServer(state)}>${t("settings.save")}</button>
      </div>
    </div>
  `;
}

function renderMappingRow(state: AppViewState, m: HookMappingDraft) {
  const update = (patch: Partial<HookMappingDraft>) => {
    if (!s.hooks) return;
    const idx = s.hooks.mappings.findIndex((x) => x.id === m.id);
    if (idx >= 0) {
      s.hooks.mappings[idx] = { ...s.hooks.mappings[idx], ...patch };
      state.requestUpdate();
    }
  };
  return html`
    <div class="oc-mcp__mapping">
      <div class="oc-mcp__mapping-grid">
        <label class="oc-settings__label">${t("settings.mcpHooks.mapName")}</label>
        <input class="oc-settings__input" .value=${m.name} placeholder="github-issues"
          @input=${(e: Event) => update({ name: (e.target as HTMLInputElement).value })} />
        <label class="oc-settings__label">${t("settings.mcpHooks.mapAction")}</label>
        <select class="oc-settings__input" .value=${m.action}
          @change=${(e: Event) => update({ action: (e.target as HTMLSelectElement).value as HookMappingDraft["action"] })}>
          <option value="agent">${t("settings.mcpHooks.actionAgent")}</option>
          <option value="wake">${t("settings.mcpHooks.actionWake")}</option>
        </select>
        <label class="oc-settings__label">${t("settings.mcpHooks.mapPath")}</label>
        <input class="oc-settings__input" .value=${m.matchPath} placeholder="/github"
          @input=${(e: Event) => update({ matchPath: (e.target as HTMLInputElement).value })} />
        <label class="oc-settings__label">${t("settings.mcpHooks.mapSource")}</label>
        <input class="oc-settings__input" .value=${m.matchSource} placeholder="github"
          @input=${(e: Event) => update({ matchSource: (e.target as HTMLInputElement).value })} />
        <label class="oc-settings__label">${t("settings.mcpHooks.mapSessionKey")}</label>
        <input class="oc-settings__input" .value=${m.sessionKey} placeholder="agent:main:main"
          @input=${(e: Event) => update({ sessionKey: (e.target as HTMLInputElement).value })} />
        <label class="oc-settings__label">${t("settings.mcpHooks.mapSessionMode")}</label>
        <select class="oc-settings__input" .value=${m.sessionMode}
          @change=${(e: Event) => update({ sessionMode: (e.target as HTMLSelectElement).value as HookMappingDraft["sessionMode"] })}>
          <option value="isolated">${t("settings.mcpHooks.modeIsolated")}</option>
          <option value="persistent">${t("settings.mcpHooks.modePersistent")}</option>
        </select>
        <label class="oc-settings__label">${t("settings.mcpHooks.mapTemplate")}</label>
        <textarea class="oc-settings__input" rows="2" .value=${m.messageTemplate}
          placeholder="payload.summary"
          @input=${(e: Event) => update({ messageTemplate: (e.target as HTMLTextAreaElement).value })}></textarea>
      </div>
      <div class="oc-settings__btn-row">
        <button class="oc-settings__btn oc-settings__btn--danger oc-settings__btn--compact"
          @click=${() => {
            if (!s.hooks) return;
            s.hooks.mappings = s.hooks.mappings.filter((x) => x.id !== m.id);
            state.requestUpdate();
          }}
        >${t("settings.mcpHooks.deleteAction")}</button>
      </div>
    </div>
  `;
}

function renderHooksHeading(state: AppViewState) {
  const h = s.hooks;
  if (!h) return nothing;
  return html`
    <h2 class="oc-settings__section-title">${t("settings.mcpHooks.hooksTitle")}</h2>
    <p class="oc-settings__hint">${t("settings.mcpHooks.hooksDesc")}</p>

    <oc-toggle-switch .label=${t("settings.mcpHooks.hooksEnable")} .checked=${h.enabled}
      @change=${(e: CustomEvent) => { h.enabled = e.detail.checked; state.requestUpdate(); }}
    ></oc-toggle-switch>

    <div class="oc-settings__form-group">
      <label class="oc-settings__label">${t("settings.mcpHooks.hooksPath")}</label>
      <input class="oc-settings__input" .value=${h.path} placeholder="/webhook"
        @input=${(e: Event) => { h.path = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
    </div>
    <div class="oc-settings__form-group">
      <label class="oc-settings__label">${t("settings.mcpHooks.hooksToken")}</label>
      <oc-password-input .value=${h.token}
        @input=${(e: CustomEvent) => { h.token = e.detail.value; state.requestUpdate(); }}
      ></oc-password-input>
      <div class="oc-settings__field-hint">${t("settings.mcpHooks.hooksTokenHint")}</div>
    </div>
    <div class="oc-settings__form-group">
      <label class="oc-settings__label">${t("settings.mcpHooks.hooksDefaultSession")}</label>
      <input class="oc-settings__input" .value=${h.defaultSessionKey} placeholder="agent:main:main"
        @input=${(e: Event) => { h.defaultSessionKey = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
    </div>

    <div class="oc-settings__card">
      <div class="oc-settings__card-title oc-mcp__mappings-head">
        <span>${t("settings.mcpHooks.mappingsTitle")}</span>
        <button class="oc-settings__btn oc-settings__btn--secondary oc-settings__btn--compact"
          @click=${() => { h.mappings.push(newMappingDraft()); state.requestUpdate(); }}
        >${t("settings.mcpHooks.addMapping")}</button>
      </div>
      ${h.mappings.length === 0
        ? html`<div class="oc-mcp__empty">${t("settings.mcpHooks.mappingsEmpty")}</div>`
        : nothing}
      ${repeat(
        h.mappings,
        (m) => m.id,
        (m) => renderMappingRow(state, m),
      )}
    </div>
  `;
}

export function renderTabMcpHooks(state: AppViewState) {
  if (s.wasConnected && !state.connected) s.initialized = false;
  s.wasConnected = state.connected;
  void init(state);
  const showForm = s.serverDraft !== null;

  // 单一根 section（与其他 tab 一致）：.oc-settings__section 的 flex:1 在多个
  // 平级 section 时会按 basis-0 平分高度，内容溢出盒外与相邻 section 重叠
  //（R63 QA：点击"添加服务器"后全页重叠）。
  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.mcpHooks.pageTitle")}</h2>
      <p class="oc-settings__page-desc">${t("settings.mcpHooks.pageDesc")}</p>

      <div class="oc-settings__card">
        <div class="oc-settings__card-title oc-mcp__mappings-head">
          <span>${t("settings.mcpHooks.serversTitle")}</span>
          <button class="oc-settings__btn oc-settings__btn--secondary oc-settings__btn--compact"
            ?disabled=${!state.connected}
            @click=${() => startAddServer(state)}
          >${t("settings.mcpHooks.addServer")}</button>
        </div>
        ${s.loading
          ? html`<div class="oc-mcp__empty">${t("chat.loading")}</div>`
          : s.servers.length === 0 && !showForm && !s.error
            ? html`<div class="oc-mcp__empty">${t("settings.mcpHooks.serversEmpty")}</div>`
            : nothing}
        ${s.servers.length > 0 ? html`<div class="oc-mcp__list">${s.servers.map((e) => renderServerRow(state, e))}</div>` : nothing}
      </div>

      ${showForm ? renderServerForm(state) : nothing}

      <oc-message-box .message=${s.successMsg ?? ""} .type=${"success"} .visible=${!!s.successMsg}></oc-message-box>
      ${s.hint && !showForm ? html`<div class="oc-settings__field-hint">${s.hint}</div>` : nothing}

      ${renderHooksHeading(state)}

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error && !showForm}></oc-message-box>

      <div class="oc-settings__btn-row">
        <button class="oc-settings__btn" ?disabled=${s.loading || !state.connected}
          @click=${() => refresh(state)}>${t("settings.mcpHooks.reload")}</button>
        <button class="oc-settings__btn oc-settings__btn--primary" ?disabled=${s.saving || !state.connected || !s.hooks}
          @click=${() => saveHooks(state)}>${t("settings.save")}</button>
      </div>
    </div>
  `;
}
