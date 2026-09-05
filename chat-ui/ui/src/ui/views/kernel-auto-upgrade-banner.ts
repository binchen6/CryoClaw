import { html, nothing } from "lit";
import { t, tWithDetail } from "../i18n.ts";
import { icons } from "../icons.ts";
import type { KernelUpdateProgress } from "../data/ipc-bridge.ts";

// 内核升级进度正文本地化：主进程 msg 是中文硬编码（保留作日志/排查与未知 step 兜底），
// 渲染层按 step 码映射 i18n 键（step 集合见主进程 kernel-updater.ts 与
// scripts/updater/kernel-update.mjs 的 progress 事件）。done 用 {version} 占位插值；
// error 保留主进程 msg 作详情（含具体失败原因）。横幅（auto）与设置-关于页（manual）共用。
export function kernelUpdateStepMessage(
  progress: Pick<KernelUpdateProgress, "step" | "msg" | "version" | "action">,
): string {
  const key =
    progress.step === "done" && progress.action === "rollback"
      ? "kernelAutoUpgrade.step.doneRollback"
      : `kernelAutoUpgrade.step.${progress.step}`;
  const translated = t(key);
  // 未知 step：回退主进程 msg
  if (translated === key) return progress.msg;
  if (progress.step === "error") return tWithDetail(key, progress.msg);
  const out = progress.version ? translated.replaceAll("{version}", progress.version) : translated;
  // 需要版本号但载荷没带（如脚本直转的 done 进度）：回退主进程 msg，避免裸露占位符
  return out.includes("{version}") ? progress.msg : out;
}

// 内核自动升级全局横幅：主进程检测到内核版本低于最低支持版本时
// （kernel-channel.json minSupported）启动后自动升级，进度经
// kernel:update-progress（source==="auto"）推到这里，不依赖设置-关于页打开。
// 手动触发的进度（source==="manual"）由 tab-about 自己处理，互不干扰。
// done 态由 app.ts 几秒后自动清除；error 态常驻直到用户点关闭。
export function renderKernelAutoUpgradeBanner(
  progress: KernelUpdateProgress | null,
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
      <div class="kernel-auto-banner__msg">${kernelUpdateStepMessage(progress)}</div>
      <div class="kernel-auto-banner__progress">
        <div class="kernel-auto-banner__bar" style="width:${pct}%"></div>
      </div>
    </div>
  `;
}
