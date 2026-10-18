import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { t } from "../i18n.ts";
import { runExitAnimation } from "../utils/exit-anim.ts";

// 通用确认弹窗：替代原生 window.confirm（渲染进程里原生 confirm 无样式且阻塞）。
// promise 化 API：const ok = await showConfirm(state, message, { danger: true });
// 2026.9：统一 cc-dialog 浮层语言（overlay / radius-16 / shadow-xl / 按钮右对齐），
// danger 操作出红色确认钮。

interface PendingConfirm {
  message: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
  settled?: boolean;
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
    exitToken++;
    document.querySelector("[data-confirm-dialog]")?.classList.remove("cc-leaving");
    pending = { message, danger: opts?.danger === true, resolve };
    host.requestUpdate();
  });
}

// 退场令牌：退场动画进行中若又有新弹窗，作废旧定时器并摘掉 leaving class
// （Lit 就地 patch 同一 overlay 节点，不摘 class 新弹窗会继承淡出中的状态）。
let exitToken = 0;

function settle(host: AppViewState, ok: boolean) {
  const p = pending;
  if (!p || p.settled) return;
  p.settled = true;
  p.resolve(ok);
  const token = ++exitToken;
  runExitAnimation(document.querySelector("[data-confirm-dialog]"), () => {
    if (token !== exitToken || pending !== p) return;
    pending = null;
    host.requestUpdate();
  });
}

export function renderConfirmDialog(state: AppViewState) {
  if (!pending) return nothing;
  const { message, danger } = pending;
  return html`
    <div class="cc-dialog-overlay" data-confirm-dialog role="dialog" aria-modal="true"
      aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message" tabindex="-1">
      <div class="cc-dialog cc-dialog--sm">
        <div class="cc-dialog__head">
          <div class="cc-dialog__title" id="confirm-dialog-title">${t("confirm.title")}</div>
        </div>
        <div class="cc-dialog__body" id="confirm-dialog-message">${message}</div>
        <div class="cc-dialog__foot">
          <button class="btn" data-dialog-dismiss @click=${() => settle(state, false)}>
            ${t("settings.cancel")}
          </button>
          <button class="btn ${danger ?"danger" : "primary"}" @click=${() => settle(state, true)}>
            ${t("settings.confirm")}
          </button>
        </div>
      </div>
    </div>
  `;
}
