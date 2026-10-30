import { html, nothing } from "lit";
import { until } from "lit/directives/until.js";
import type { AppViewState } from "./app-view-state.ts";
import { setCryoClawView } from "./app-view-switch.ts";
import { t } from "./i18n.ts";
import type { CryoClawViewId } from "./views/registry.ts";

type DeferredViewId = Exclude<CryoClawViewId, "chat">;
type ViewContent = () => unknown;
type ViewRenderer = (state: AppViewState, content?: ViewContent) => unknown;
type ViewOpener = (state: AppViewState, option?: any) => void;

const renderers = new Map<DeferredViewId, ViewRenderer>();
const openers = new Map<DeferredViewId, ViewOpener>();
const pending = new Map<DeferredViewId, Promise<ViewRenderer>>();

function routeLoading() {
  return html`<div class="route-loading" role="status" aria-live="polite">
    <span class="route-loading__track" aria-hidden="true"><span></span></span>
    <span>${t("settings.loading")}</span>
  </div>`;
}

function routeError(state: AppViewState, view: DeferredViewId) {
  return html`<div class="route-loading route-loading--error" role="alert">
    <span>${t("workspace.loadFailed")}</span>
    <button class="btn" type="button" @click=${() => {
      renderers.delete(view);
      state.requestUpdate();
    }}>${t("gateway.retry")}</button>
  </div>`;
}

async function importRenderer(view: DeferredViewId): Promise<ViewRenderer> {
  switch (view) {
    case "dashboard": {
      await import("./components/oc-dashboard.ts");
      return (_state, content) => content?.() ?? nothing;
    }
    case "settings": {
      const module = await import("./views/settings/settings-view.ts");
      return (state) => module.renderSettingsView(state);
    }
    case "setup": {
      const module = await import("./views/setup/setup-view.ts");
      return (state) => module.renderSetupView(state);
    }
    case "extensions": {
      const module = await import("./app-extensions.ts");
      openers.set(view, module.openExtensionsView);
      return (state) => module.renderExtensionsView(state);
    }
    case "workspace": {
      const module = await import("./app-workspace.ts");
      openers.set(view, module.openWorkspaceView);
      return (state) => module.renderWorkspaceIntegratedView(state);
    }
    case "tasks": {
      const module = await import("./app-tasks.ts");
      openers.set(view, module.openTasksView);
      return (state) => module.renderTasksView(state);
    }
  }
}

function loadRenderer(view: DeferredViewId): Promise<ViewRenderer> {
  const loaded = renderers.get(view);
  if (loaded) return Promise.resolve(loaded);
  const existing = pending.get(view);
  if (existing) return existing;
  const request = importRenderer(view)
    .catch((): ViewRenderer => (state) => routeError(state, view))
    .then((renderer) => {
      renderers.set(view, renderer);
      pending.delete(view);
      return renderer;
    });
  pending.set(view, request);
  return request;
}

export function preloadViewModule(view: CryoClawViewId): void {
  if (view !== "chat") void loadRenderer(view);
}

function renderDeferredView(state: AppViewState, view: DeferredViewId, content?: ViewContent) {
  const loaded = renderers.get(view);
  if (loaded) return loaded(state, content);
  return until(
    loadRenderer(view).then((renderer) => renderer(state, content)),
    routeLoading(),
  );
}

export function renderDashboardView(state: AppViewState, content: ViewContent) {
  return renderDeferredView(state, "dashboard", content);
}

export function renderSettingsView(state: AppViewState) {
  return renderDeferredView(state, "settings");
}

export function renderSetupView(state: AppViewState) {
  return renderDeferredView(state, "setup");
}

export function renderExtensionsView(state: AppViewState) {
  return renderDeferredView(state, "extensions");
}

export function renderWorkspaceIntegratedView(state: AppViewState) {
  return renderDeferredView(state, "workspace");
}

export function renderTasksView(state: AppViewState) {
  return renderDeferredView(state, "tasks");
}

function openDeferredView(state: AppViewState, view: DeferredViewId, option?: any) {
  const loaded = openers.get(view);
  if (loaded) {
    loaded(state, option);
    return;
  }
  setCryoClawView(state, view);
  void loadRenderer(view).then(() => {
    if (state.settings.cryoclawView === view) openers.get(view)?.(state, option);
  }).catch(() => state.requestUpdate());
}

export function openTasksView(state: AppViewState, tab: "runs" | "cron" = "runs") {
  openDeferredView(state, "tasks", tab);
}

export function openWorkspaceView(state: AppViewState, mode: "files" | "git" = "files") {
  openDeferredView(state, "workspace", mode);
}

export function openExtensionsView(state: AppViewState, tab: "skills" | "plugins" = "skills") {
  openDeferredView(state, "extensions", tab);
}
