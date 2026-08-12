/**
 * Settings: Advanced Tab.
 *
 * 浏览器模式 3 选 radio（值与 settings-ipc.ts 的 browserMode 完全一致）：
 *   - webbridge：通过浏览器扩展接管系统默认浏览器（Chrome/Edge）
 *   - openclaw：CryoClaw 启动独立 Chromium 实例
 *   - user：OpenClaw 当前会话 —— 复用用户已开的 Chrome 会话（gateway 内置 user profile）
 *
 * 切到 webbridge 时跑 precheck：
 *   - 三组件（binary/skill/extension）任一缺 → 弹 RepairModal「修复并启用」
 *   - 默认浏览器不是 Chrome/Edge → 弹 RepairModal 的 default-unsupported 视图
 *   - 全过 → 接受切换
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { t, tWithDetail } from "../../i18n.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import "../../components/toggle-switch.ts";
import "../../components/message-box.ts";
import { getConfigSnapshot, getCachedConfigSnapshot } from "../../controllers/config.ts";
import { runConfigPatch } from "./tab-patch.ts";
import { extractAdvancedView, applyAdvancedSave } from "./tab-channels.lib.ts";

type BrowserUiMode = "webbridge" | "openclaw" | "user";

// 读 IPC：直接用 browserMode 字段；遇到老后端 "chrome" alias 归一化成 "user"
function ipcToUi(adv: ipc.AdvancedConfig): BrowserUiMode {
  const m = adv.browserMode;
  if (m === "webbridge" || m === "openclaw" || m === "user") return m;
  if (m === "chrome") return "user"; // legacy alias
  // 老 IPC 没 browserMode → 看 browserProfile
  const stored = adv.browserProfile;
  if (stored === "user" || stored === "chrome" || stored === "chrome-relay") {
    return "user";
  }
  return "openclaw";
}

type RepairModalState =
  | null
  | {
      view: "default-unsupported";
      // 「再次检查」按钮逻辑用：失败原因消息
      message?: string;
      messageKind?: "error" | "info";
      saving?: boolean;
    }
  | {
      view: "repair";
      missing: { binary: boolean; skill: boolean; extension: boolean };
      defaultBrowser: { id: string; name: string } | null;
      // 修复中显示的状态消息
      message?: string;
      messageKind?: "error" | "info";
      saving?: boolean;
    };

// Advanced 页状态必须可整体回滚，避免切换 CLI/登录项后的脏状态跨会话残留。
function createAdvancedState() {
  return {
    browserMode: "openclaw" as BrowserUiMode,
    // 上一次确认有效（precheck 通过 / 用户保存过）的 mode；切到 webbridge 失败时回滚
    lastValidMode: "openclaw" as BrowserUiMode,
    imessageEnabled: false,
    launchAtLoginSupported: false,
    launchAtLogin: false,
    clawHubRegistry: "",
    gatewayReloadMode: "hybrid" as "off" | "restart" | "hot" | "hybrid",
    execMode: "ask" as "ask" | "auto" | "full",
    execHost: "auto" as "auto" | "gateway" | "node" | "sandbox",
    execReviewerModel: "",
    sandboxMode: "off" as "off" | "non-main" | "all",
    sandboxWorkspaceAccess: "rw" as "rw" | "ro" | "none",
    // Docker 是否可用（get-advanced 附带检测结果）；默认 true 避免加载前闪烁警告
    dockerAvailable: true,
    // 保存后热应用/重启提示
    hint: null as string | null,
    cliInstalled: false,
    cliLoading: false,
    saving: false,
    error: null as string | null,
    successMsg: null as string | null,
    initialized: false,
    // webbridge precheck 进行中标志，避免切换抖动
    precheckInflight: false,
    // 是否需要在 radio 下方显示「⚠ WebBridge 需要修复」链接
    webbridgeHealthBroken: false,
    // 缓存最近一次 precheck 结果，health link 点击复用
    lastPrecheck: null as ipc.WebbridgePrecheckData | null,
    // 修复 modal 可见性 + 视图状态
    repairModal: null as RepairModalState,
  };
}

const s = createAdvancedState();

// 退出 Settings 时直接丢掉 Advanced 页缓存，下次重新从 IPC 拉真配置。
function resetAdvancedState() {
  Object.assign(s, createAdvancedState());
}

async function init(state: AppViewState) {
  if (s.initialized) return;
  s.initialized = true;
  try {
    // openclaw.json 侧字段（热应用模式/执行权限/沙箱/iMessage）直接读 config 快照（R4）；
    // IPC 只保留本地字段（浏览器模式/开机自启/ClawHub registry/docker 检测）。
    const snapshot = getCachedConfigSnapshot() ?? (state.client ? await getConfigSnapshot(state.client) : null);
    const advView = extractAdvancedView(snapshot?.config ?? null);
    const [adv, cli] = await Promise.all([ipc.settingsGetAdvanced(), ipc.settingsGetCliStatus()]);
    s.browserMode = ipcToUi(adv);
    s.lastValidMode = s.browserMode;
    s.imessageEnabled = advView.imessageEnabled;
    s.launchAtLoginSupported = adv.launchAtLoginSupported ?? false;
    s.launchAtLogin = adv.launchAtLogin ?? false;
    s.clawHubRegistry = adv.clawHubRegistry ?? "";
    s.gatewayReloadMode = advView.gatewayReloadMode;
    s.execMode = advView.execMode;
    s.execHost = advView.execHost;
    s.execReviewerModel = advView.execReviewerModel;
    s.sandboxMode = advView.sandboxMode;
    s.sandboxWorkspaceAccess = advView.sandboxWorkspaceAccess;
    s.dockerAvailable = adv.dockerAvailable !== false;
    s.cliInstalled = cli.installed ?? false;
    state.requestUpdate();
    // 当前已是 webbridge → 后台跑一次 precheck 看是否需要显示 health link
    if (s.browserMode === "webbridge") {
      void refreshWebbridgeHealth(state);
    }
  } catch {}
}

async function toggleCli(state: AppViewState, install: boolean) {
  s.cliLoading = true; state.requestUpdate();
  try {
    if (install) await ipc.settingsInstallCli(); else await ipc.settingsUninstallCli();
    const cli = await ipc.settingsGetCliStatus();
    s.cliInstalled = cli.installed;
  } catch {}
  s.cliLoading = false; state.requestUpdate();
}

// 当前 mode=webbridge 时主动跑 precheck，更新 health link 可见性。
async function refreshWebbridgeHealth(state: AppViewState) {
  if (s.browserMode !== "webbridge") {
    s.webbridgeHealthBroken = false;
    s.lastPrecheck = null;
    state.requestUpdate();
    return;
  }
  try {
    const pre = await ipc.settingsWebbridgePrecheck();
    if (pre?.ok) {
      s.webbridgeHealthBroken = false;
      s.lastPrecheck = null;
    } else if (pre) {
      s.webbridgeHealthBroken = true;
      s.lastPrecheck = pre;
    } else {
      s.webbridgeHealthBroken = false;
    }
  } catch {
    s.webbridgeHealthBroken = false;
  }
  state.requestUpdate();
}

// 用户切到非 webbridge → 直接接受；切到 webbridge → 跑 precheck，失败弹 modal 并回滚 radio
async function onBrowserModeChange(state: AppViewState, next: BrowserUiMode) {
  if (next !== "webbridge") {
    s.browserMode = next;
    s.lastValidMode = next;
    s.webbridgeHealthBroken = false;
    s.lastPrecheck = null;
    state.requestUpdate();
    return;
  }
  if (s.precheckInflight) return;
  s.precheckInflight = true;
  // 先乐观切到 webbridge 显示，precheck 失败再回滚
  s.browserMode = "webbridge";
  state.requestUpdate();
  try {
    const pre = await ipc.settingsWebbridgePrecheck();
    if (pre?.ok) {
      s.lastValidMode = "webbridge";
      s.webbridgeHealthBroken = false;
      s.lastPrecheck = null;
    } else if (pre) {
      // 回滚 radio + 弹修复 modal
      s.browserMode = s.lastValidMode;
      s.lastPrecheck = pre;
      openRepairModal(pre);
    } else {
      s.browserMode = s.lastValidMode;
      s.error = t("settings.error.saveFailed");
    }
  } catch (err: any) {
    s.browserMode = s.lastValidMode;
    s.error = tWithDetail("settings.error.saveFailed", err?.message);
  } finally {
    s.precheckInflight = false;
    state.requestUpdate();
  }
}

function openRepairModal(pre: ipc.WebbridgePrecheckData) {
  if (pre.defaultUnsupported) {
    s.repairModal = { view: "default-unsupported" };
  } else {
    s.repairModal = {
      view: "repair",
      missing: pre.missing,
      defaultBrowser: pre.defaultBrowser,
    };
  }
}

function closeRepairModal(state: AppViewState) {
  s.repairModal = null;
  state.requestUpdate();
}

// 「修复并启用」按钮 / 「再次检查」按钮统一入口
async function onRepairConfirm(state: AppViewState) {
  if (!s.repairModal) return;
  const m = s.repairModal;

  // 视图 A：默认浏览器不支持 → 重跑 precheck，命中其它视图就切，OK 就直接 enable
  if (m.view === "default-unsupported") {
    // saving=true 时保留之前的 message —— 避免红框消失再出现造成 modal 上下抖动
    s.repairModal = { ...m, saving: true };
    state.requestUpdate();
    try {
      const pre = await ipc.settingsWebbridgePrecheck();
      if (pre?.ok) {
        // 默认浏览器改好且全过 → 直接 enable（handler 内部 skip 不需要的步骤）
        // 保持 saving=true，message 不动（spinner 已在按钮上转），避免红框文案中途切换造成抖动
        const res = await ipc.settingsWebbridgeRepairAndEnable();
        if (res.success) {
          s.browserMode = "webbridge";
          s.lastValidMode = "webbridge";
          s.repairModal = null;
          await refreshWebbridgeHealth(state);
          return;
        }
        s.repairModal = {
          view: "default-unsupported",
          saving: false,
          message: t("settings.advanced.wbRepairFailed") + (res.message ? ": " + res.message : ""),
          messageKind: "error",
        };
      } else if (pre) {
        // 还是不过 → 切换视图（unsupported 仍 unsupported；或现在是 repair 视图）
        openRepairModal(pre);
      } else {
        s.repairModal = {
          view: "default-unsupported",
          saving: false,
          message: t("settings.advanced.wbRepairFailed"),
          messageKind: "error",
        };
      }
    } catch (err: any) {
      s.repairModal = {
        view: "default-unsupported",
        saving: false,
        message: tWithDetail("settings.error.saveFailed", err?.message),
        messageKind: "error",
      };
    } finally {
      state.requestUpdate();
    }
    return;
  }

  // 视图 B：组件需修复 → 调 repair-and-enable
  // 保留之前的 message —— 反复点修复时「Google 仍在运行」红框文字不消失，避免 modal 高度抖动
  s.repairModal = { ...m, saving: true };
  state.requestUpdate();
  try {
    const res = await ipc.settingsWebbridgeRepairAndEnable();
    if (res.success) {
      s.browserMode = "webbridge";
      s.lastValidMode = "webbridge";
      s.repairModal = null;
      await refreshWebbridgeHealth(state);
      return;
    }
    if (res.code === "BROWSER_RUNNING") {
      const bn = res.browserName ?? "browser";
      s.repairModal = {
        ...m,
        saving: false,
        message: t("settings.advanced.wbRepairBrowserRunning").replace(/\{browser\}/g, bn),
        messageKind: "error",
      };
    } else if (res.code === "DEFAULT_BROWSER_UNSUPPORTED") {
      // 修复中默认浏览器变了 → 切到 unsupported 视图
      s.repairModal = { view: "default-unsupported" };
    } else {
      s.repairModal = {
        ...m,
        saving: false,
        message: t("settings.advanced.wbRepairFailed") + (res.message ? ": " + res.message : ""),
        messageKind: "error",
      };
    }
  } catch (err: any) {
    s.repairModal = {
      ...m,
      saving: false,
      message: tWithDetail("settings.error.saveFailed", err?.message),
      messageKind: "error",
    };
  } finally {
    state.requestUpdate();
  }
}

async function handleSave(state: AppViewState) {
  s.saving = true; s.error = null; s.successMsg = null; s.hint = null; state.requestUpdate();
  // 1) openclaw.json 侧（热应用模式/执行权限/沙箱/iMessage）走 config.patch
  const patched = await runConfigPatch(state, (draft) => {
    applyAdvancedSave(draft, {
      gatewayReloadMode: s.gatewayReloadMode,
      execMode: s.execMode,
      execHost: s.execHost,
      execReviewerModel: s.execReviewerModel,
      sandboxMode: s.sandboxMode,
      sandboxWorkspaceAccess: s.sandboxWorkspaceAccess,
      imessageEnabled: s.imessageEnabled,
    });
  });
  if (!patched.ok) {
    s.saving = false; s.error = patched.error ?? t("settings.error.saveFailed"); state.requestUpdate();
    return;
  }
  // 2) 本地字段（浏览器模式/开机自启/ClawHub registry）走保留的 save-advanced IPC
  try {
    await ipc.settingsSaveAdvanced({
      // browserMode 值与后端一字不差："webbridge" | "openclaw" | "user"
      browserMode: s.browserMode,
      launchAtLogin: s.launchAtLogin,
      clawHubRegistry: s.clawHubRegistry,
    });
    s.saving = false; s.successMsg = t("settings.saved"); s.hint = patched.hint ?? null; state.requestUpdate();
  } catch (e: any) { s.saving = false; s.error = tWithDetail("settings.error.saveFailed", e?.message); state.requestUpdate(); }
}

export function resetAdvancedTab() { resetAdvancedState(); }

// 修复中按钮内容：固定 16x16 旋转 SVG，不带文字 → 与原文字按钮的 min-width=112 配合，按钮尺寸不变
const wbModalSpinner = html`
  <svg class="wb-modal-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>
`;

function renderRepairModal(state: AppViewState) {
  const m = s.repairModal;
  if (!m) return nothing;

  const close = () => { if (!m.saving) closeRepairModal(state); };

  if (m.view === "default-unsupported") {
    return html`
      <div class="wb-modal-overlay" role="dialog" aria-modal="true" @click=${close}>
        <div class="wb-modal-card" @click=${(e: Event) => e.stopPropagation()}>
          <h3 class="wb-modal-title">${t("settings.advanced.wbRepairDefaultUnsupportedTitle")}</h3>
          <p class="wb-modal-desc">${t("settings.advanced.wbRepairDefaultUnsupportedDesc")}</p>
          <div class="wb-modal-msg ${m.message ? (m.messageKind ?? "info") : ""}" style=${m.message ? "" : "visibility:hidden;"}>
            ${m.message ?? "—"}
          </div>
          <div class="wb-modal-actions">
            <button type="button" class="oc-settings__btn" ?disabled=${m.saving} @click=${close}>
              ${t("settings.advanced.wbRepairCancel")}
            </button>
            <button type="button" class="oc-settings__btn oc-settings__btn--primary" ?disabled=${m.saving} @click=${() => onRepairConfirm(state)}>
              ${m.saving ? wbModalSpinner : t("settings.advanced.wbRepairDefaultUnsupportedRetry")}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // view === "repair"
  const items: Array<{ key: "binary" | "skill" | "extension"; label: string }> = [
    { key: "binary", label: t("settings.advanced.wbRepairItemBinary") },
    { key: "skill", label: t("settings.advanced.wbRepairItemSkill") },
    {
      key: "extension",
      label: m.defaultBrowser
        ? t("settings.advanced.wbRepairItemExtensionWith").replace(/\{browser\}/g, m.defaultBrowser.name)
        : t("settings.advanced.wbRepairItemExtension"),
    },
  ];

  return html`
    <div class="wb-modal-overlay" role="dialog" aria-modal="true" @click=${close}>
      <div class="wb-modal-card" @click=${(e: Event) => e.stopPropagation()}>
        <h3 class="wb-modal-title">${t("settings.advanced.wbRepairTitle")}</h3>
        <p class="wb-modal-desc">${t("settings.advanced.wbRepairDesc")}</p>
        <ul class="wb-repair-list">
          ${items.map(it => html`
            <li class="wb-repair-item ${m.missing[it.key] ? "missing" : "ok"}">
              ${m.missing[it.key] ? "✗ " : "✓ "}${it.label}
            </li>
          `)}
        </ul>
        <!-- 永远渲染 msg 占位元素：消息切换不会让 modal 高度跳变（旧分支同样的"内容比对跳过 DOM"思路在 Lit 下用占位实现） -->
        <div class="wb-modal-msg ${m.message ? (m.messageKind ?? "info") : ""}" style=${m.message ? "" : "visibility:hidden;"}>
          ${m.message ?? "—"}
        </div>
        <div class="wb-modal-actions">
          <button type="button" class="oc-settings__btn" ?disabled=${m.saving} @click=${close}>
            ${t("settings.advanced.wbRepairCancel")}
          </button>
          <button type="button" class="oc-settings__btn oc-settings__btn--primary" ?disabled=${m.saving} @click=${() => onRepairConfirm(state)}>
            ${m.saving ? wbModalSpinner : t("settings.advanced.wbRepairConfirm")}
          </button>
        </div>
      </div>
    </div>
  `;
}

export function renderTabAdvanced(state: AppViewState) {
  if (!s.initialized) init(state);

  return html`
    <div class="oc-settings__section">
      <h2 class="oc-settings__section-title">${t("settings.advanced.title")}</h2>
      <p class="oc-settings__hint">${t("settings.advanced.desc")}</p>

      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.advanced.clawHubRegistry")}</label>
        <input class="oc-settings__input" .value=${s.clawHubRegistry}
          @input=${(e: Event) => { s.clawHubRegistry = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
      </div>

      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.advanced.gatewayReload")}</label>
        <div class="oc-settings__radio-group">
          ${(["hybrid", "hot", "restart", "off"] as const).map((mode) => html`
            <label class="oc-settings__radio">
              <input type="radio" name="adv-reload" value=${mode}
                .checked=${s.gatewayReloadMode === mode}
                @change=${() => { s.gatewayReloadMode = mode; state.requestUpdate(); }} />
              ${t(`settings.advanced.reload.${mode}`)}
            </label>
          `)}
        </div>
      </div>

      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.advanced.execMode")}</label>
        <div class="oc-settings__radio-group">
          ${([["ask", "settings.advanced.execModeAsk"], ["auto", "settings.advanced.execModeAuto"], ["full", "settings.advanced.execModeApproveAll"]] as const).map(([value, key]) => html`
            <label class="oc-settings__radio">
              <input type="radio" name="adv-exec" value=${value}
                .checked=${s.execMode === value}
                @change=${() => { s.execMode = value; state.requestUpdate(); }} />
              ${t(key)}
            </label>
          `)}
        </div>
        ${s.execMode === "auto" ? html`
          <input class="oc-settings__input" style="margin-top:8px" .value=${s.execReviewerModel}
            placeholder=${t("settings.advanced.execReviewerModel")}
            @input=${(e: Event) => { s.execReviewerModel = (e.target as HTMLInputElement).value; state.requestUpdate(); }} />
        ` : nothing}
      </div>

      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.advanced.sandboxMode")}</label>
        ${!s.dockerAvailable ? html`
          <div class="oc-settings__hint" style="color:var(--danger);margin-bottom:6px">
            ⚠ ${t("settings.advanced.sandboxDockerMissing")}
          </div>
        ` : nothing}
        <div class="oc-settings__radio-group">
          ${([["off", "settings.advanced.sandboxOff"], ["non-main", "settings.advanced.sandboxNonMain"], ["all", "settings.advanced.sandboxAll"]] as const).map(([value, key]) => html`
            <label class="oc-settings__radio">
              <input type="radio" name="adv-sandbox" value=${value}
                .checked=${s.sandboxMode === value}
                ?disabled=${!s.dockerAvailable && value !== "off"}
                @change=${() => { s.sandboxMode = value; state.requestUpdate(); }} />
              ${t(key)}
            </label>
          `)}
        </div>
        ${s.sandboxMode !== "off" ? html`
          <div class="oc-settings__radio-group" style="margin-top:6px">
            ${([["rw", "settings.advanced.sandboxRw"], ["ro", "settings.advanced.sandboxRo"], ["none", "settings.advanced.sandboxNone"]] as const).map(([value, key]) => html`
              <label class="oc-settings__radio">
                <input type="radio" name="adv-sandbox-ws" value=${value}
                  .checked=${s.sandboxWorkspaceAccess === value}
                  @change=${() => { s.sandboxWorkspaceAccess = value; state.requestUpdate(); }} />
                ${t(key)}
              </label>
            `)}
          </div>
        ` : nothing}
        <div class="oc-settings__radio-group" style="margin-top:6px">
          <label class="oc-settings__radio">
            <input type="radio" name="adv-exec-host" value="auto"
              .checked=${s.execHost === "auto"}
              @change=${() => { s.execHost = "auto"; state.requestUpdate(); }} />
            ${t("settings.advanced.execHostAuto")}
          </label>
          <label class="oc-settings__radio">
            <input type="radio" name="adv-exec-host" value="gateway"
              .checked=${s.execHost === "gateway"}
              @change=${() => { s.execHost = "gateway"; state.requestUpdate(); }} />
            ${t("settings.advanced.execHostGateway")}
          </label>
          <label class="oc-settings__radio">
            <input type="radio" name="adv-exec-host" value="sandbox"
              .checked=${s.execHost === "sandbox"}
              ?disabled=${!s.dockerAvailable}
              @change=${() => { s.execHost = "sandbox"; state.requestUpdate(); }} />
            ${t("settings.advanced.execHostSandbox")}
          </label>
        </div>
      </div>

      <div class="oc-settings__form-group">
        <label class="oc-settings__label">${t("settings.advanced.browserProfile")}</label>
        <div class="oc-settings__radio-group">
          <label class="oc-settings__radio">
            <input type="radio" name="adv-browser" value="webbridge"
              .checked=${s.browserMode === "webbridge"}
              ?disabled=${s.precheckInflight}
              @change=${() => onBrowserModeChange(state, "webbridge")} />
            ${t("settings.advanced.browserWebbridge")}
          </label>
          <label class="oc-settings__radio">
            <input type="radio" name="adv-browser" value="openclaw"
              .checked=${s.browserMode === "openclaw"}
              @change=${() => onBrowserModeChange(state, "openclaw")} />
            ${t("settings.advanced.browserDedicated")}
          </label>
          <label class="oc-settings__radio">
            <input type="radio" name="adv-browser" value="user"
              .checked=${s.browserMode === "user"}
              @change=${() => onBrowserModeChange(state, "user")} />
            ${t("settings.advanced.browserChrome")}
          </label>
        </div>
        ${s.webbridgeHealthBroken && s.browserMode === "webbridge"
          ? html`<a href="#" class="wb-health-link"
              @click=${(e: Event) => { e.preventDefault(); if (s.lastPrecheck) openRepairModal(s.lastPrecheck); state.requestUpdate(); }}
            >${t("settings.advanced.wbHealthBroken")}</a>`
          : nothing}
      </div>

      <div class="oc-settings__form-group">
        <oc-toggle-switch .label=${t("settings.advanced.imessage")} .checked=${s.imessageEnabled}
          @change=${(e: CustomEvent) => { s.imessageEnabled = e.detail.checked; state.requestUpdate(); }}
        ></oc-toggle-switch>
      </div>

      ${s.launchAtLoginSupported ? html`
        <div class="oc-settings__form-group">
          <oc-toggle-switch .label=${t("settings.advanced.launchAtLogin")} .checked=${s.launchAtLogin}
            @change=${(e: CustomEvent) => { s.launchAtLogin = e.detail.checked; state.requestUpdate(); }}
          ></oc-toggle-switch>
        </div>
      ` : nothing}

      <div class="oc-settings__form-group">
        <div class="oc-toggle ${s.cliLoading ? 'oc-toggle--disabled' : ''}" @click=${() => { if (!s.cliLoading) toggleCli(state, !s.cliInstalled); }}>
          <span class="oc-toggle-label">${s.cliLoading ? t("settings.advanced.cliInstalling") : html`${t("settings.advanced.cliLabel")} <code class="oc-settings__cli-code">openclaw</code>`}</span>
          <span class="oc-toggle-track ${s.cliInstalled ? 'oc-toggle-track--on' : ''}">
            <span class="oc-toggle-thumb"></span>
          </span>
        </div>
      </div>

      <oc-message-box .message=${s.error ?? ""} .type=${"error"} .visible=${!!s.error}></oc-message-box>
      <oc-message-box .message=${s.successMsg ?? ""} .type=${"success"} .visible=${!!s.successMsg}></oc-message-box>
      ${s.hint ? html`<div class="oc-settings__hint" style="margin-top:4px">${s.hint}</div>` : nothing}

      <div class="oc-settings__btn-row">
        <button class="oc-settings__btn oc-settings__btn--primary" ?disabled=${s.saving} @click=${() => handleSave(state)}>${t("settings.save")}</button>
      </div>

      ${renderRepairModal(state)}
    </div>
  `;
}
