import { html, nothing } from "lit";
import { t } from "../i18n.ts";
import { icons } from "../icons.ts";

// 内核自动升级全局横幅：主进程检测到内核版本低于最低支持版本时
// （kernel-channel.json minSupported）启动后自动升级，进度经
// kernel:update-progress（source==="auto"）推到这里，不依赖设置-关于页打开。
// 手动触发的进度（source==="manual"）由 tab-about 自己处理，互不干扰。
// done 态由 app.ts 几秒后自动清除；error 态常驻直到用户点关闭。
export function renderKernelAutoUpgradeBanner(
  progress: { step: string; pct: number; msg: string } | null,
  onClose?: () => void,
) {
  if (!progress) return nothing;
  const done = progress.step === "done";
  const failed = progress.step === "error";
  const pct = Math.max(0, Math.min(100, Math.round(progress.pct)));
  const title = done
    ? t("kernelAutoUpgrade.done")
    : failed
      ? t("kernelAutoUpgrade.error")
      : t("kernelAutoUpgrade.title");

  return html`
    <div
      class="kernel-auto-banner ${done ? "kernel-auto-banner--done" : ""} ${failed ? "kernel-auto-banner--error" : ""}"
      role="status"
    >
      <div class="kernel-auto-banner__head">
        <span class="kernel-auto-banner__title">${title}</span>
        <span class="kernel-auto-banner__pct">${pct}%</span>
        ${failed
          ? html`<button
              class="kernel-auto-banner__close"
              type="button"
              @click=${() => onClose?.()}
              aria-label=${t("releaseNotes.close")}
            >
              ${icons.x}
            </button>`
          : nothing}
      </div>
      <div class="kernel-auto-banner__msg">${progress.msg}</div>
      <div class="kernel-auto-banner__progress">
        <div class="kernel-auto-banner__bar" style="width:${pct}%"></div>
      </div>
    </div>
  `;
}
