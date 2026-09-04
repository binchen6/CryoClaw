import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { t } from "../i18n.ts";

// 通用确认弹窗：替代原生 window.confirm（渲染进程里原生 confirm 无样式且阻塞）。
// promise 化 API：const ok = await showConfirm(state, message, { danger: true });
// 2026.9：统一 cc-dialog 浮层语言（overlay / radius-16 / shadow-xl / 按钮右对齐），
// danger 操作出红色确认钮。

interface PendingConfirm {
  message: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

let pending: PendingConfirm | null = null;

export function showConfirm(
  host: AppViewState,
  message: string,
  opts?: { danger?: boolean },
): Promise<boolean> {
  // 已有未决弹窗时先按"取消"结算旧请求，避免 promise 悬挂
  pending?.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = { message, danger: opts?.danger === true, resolve };
    host.requestUpdate();
  });
}

function settle(host: AppViewState, ok: boolean) {
  const p = pending;
  pending = null;
  host.requestUpdate();
  p?.resolve(ok);
}

export function renderConfirmDialog(state: AppViewState) {
  if (!pending) return nothing;
  const { message, danger } = pending;
  return html`
    <div class="cc-dialog-overlay" role="dialog" aria-modal="true">
      <div class="cc-dialog cc-dialog--sm">
        <div class="cc-dialog__head">
          <div class="cc-dialog__title">${t("confirm.title")}</div>
        </div>
        <div class="cc-dialog__body">${message}</div>
        <div class="cc-dialog__foot">
          <button class="btn" @click=${() => settle(state, false)}>
            ${t("settings.cancel")}
          </button>
          <button class="btn ${danger ? "danger" : "primary"}" @click=${() => settle(state, true)}>
            ${t("settings.confirm")}
          </button>
        </div>
      </div>
    </div>
  `;
}
