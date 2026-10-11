/**
 * chat-queue.ts — 待发送队列条（compose 上方）纯渲染模块。
 * 对齐 question-cards/progress-card 拆出范式：纯函数、props 进、TemplateResult 出。
 *
 * 状态说明：queueEditingId 为模块级非响应式瞬态（渲染由 onRequestUpdate 驱动），
 * 行内编辑态随会话切换重置（resetQueueStrip，由 renderChat 的 lastSessionKey 门控调用）。
 */
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../icons.ts";
import { t } from "../i18n.ts";
import type { ChatProps } from "./chat.ts";

// 队列行内编辑态（非响应式，渲染由 requestUpdate 驱动）：记录正在编辑的队列项 id
let queueEditingId: string | null = null;

/** 切会话时复位行内编辑态（避免编辑态残留到新会话的队列项上）。 */
export function resetQueueStrip() {
  queueEditingId = null;
}

export function renderQueueStrip(props: ChatProps) {
  if (!props.queue.length) {
    return nothing;
  }
  return html`
    <div class="chat-queue" role="status" aria-live="polite">
      <div class="chat-queue__title">${t("chat.queued")} (${props.queue.length})</div>
      ${!props.connected
        ? html`<div class="chat-queue__pending-hint">${t("chat.queuedPendingHint")}</div>`
        : nothing}
      <div class="chat-queue__list">
        ${props.queue.map((item) => {
          const editing = queueEditingId === item.id;
          const saveEdit = (text: string) => {
            queueEditingId = null;
            props.onQueueEdit?.(item.id, text);
          };
          const cancelEdit = () => {
            queueEditingId = null;
            props.onRequestUpdate?.();
          };
          return html`
            <div class="chat-queue__item">
              ${
                editing
                  ? html`
                    <textarea
                      class="chat-queue__edit-input"
                      rows="2"
                      .value=${String(item.text ?? "")}
                      ${ref((el) => {
                        if (el && document.activeElement !== el) {
                          (el as HTMLTextAreaElement).focus();
                        }
                      })}
                      @keydown=${(e: KeyboardEvent) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          cancelEdit();
                        } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                          e.preventDefault();
                          saveEdit((e.currentTarget as HTMLTextAreaElement).value);
                        }
                      }}
                    ></textarea>
                    <div class="chat-queue__actions">
                      <button
                        class="btn chat-queue__action"
                        type="button"
                        @click=${(e: Event) => {
                          const root = (e.currentTarget as HTMLElement).closest(".chat-queue__item");
                          const input = root?.querySelector(".chat-queue__edit-input");
                          saveEdit((input as HTMLTextAreaElement | null)?.value ?? "");
                        }}
                      >
                        ${t("chat.queueSave")}
                      </button>
                      <button
                        class="btn chat-queue__action"
                        type="button"
                        @click=${cancelEdit}
                      >
                        ${t("chat.cancel")}
                      </button>
                    </div>
                  `
                  : html`
                    <div class="chat-queue__text">
                      ${
                        item.text ||
                        (item.attachments?.length ? `${t("chat.image")} (${item.attachments.length})` : "")
                      }
                    </div>
                    <div class="chat-queue__actions">
                      <button
                        class="btn chat-queue__action"
                        type="button"
                        aria-label=${t("chat.queueEdit")}
                        data-tooltip=${t("chat.queueEdit")}
                        ?disabled=${!props.onQueueEdit}
                        @click=${() => {
                          queueEditingId = item.id;
                          props.onRequestUpdate?.();
                        }}
                      >
                        ${icons.edit}
                      </button>
                      <button
                        class="btn chat-queue__action"
                        type="button"
                        aria-label=${t("chat.queueSendNow")}
                        data-tooltip=${t("chat.queueSendNow")}
                        ?disabled=${!props.connected || !props.onQueueSendNow}
                        @click=${() => props.onQueueSendNow?.(item.id)}
                      >
                        ${icons.send}
                      </button>
                      <button
                        class="btn chat-queue__remove"
                        type="button"
                        aria-label=${t("chat.removeQueuedMessage")}
                        @click=${() => props.onQueueRemove(item.id)}
                      >
                        ${icons.x}
                      </button>
                    </div>
                  `
              }
            </div>
          `;
        })}
      </div>
    </div>
  `;
}
