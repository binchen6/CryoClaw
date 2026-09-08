/**
 * question-card.ts — 内核问答卡片渲染（R61）。
 *
 * 挂载：views/chat.ts 线程尾部（历史 → 流式 → 子代理卡 → 问答卡）。
 * 样式与 Progress Card / 子代理卡同一居中阅读列（--chat-column）与卡片语言
 * （bg-elevated + hairline + radius-12），见 styles/chat.css .chat-question-*。
 *
 * 交互语义（对齐内核 question-gateway-runtime）：
 * - 单问题 + 非 multiSelect + 非 secret（isTappableQuestion）：选项按钮点击即答；
 * - secret 单问题：选项按钮点击提交 ["stored"]（值不落 WS 明文）；
 * - 其他形态（多问题/multiSelect）：卡片提示在输入框用选项原文回复；
 * - 「跳过」按钮 → question.resolve { cancel: true }。
 */
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../i18n.ts";
import {
  buildResolveParams,
  isTappableQuestion,
  type QuestionPrompt,
} from "../chat/question-cards.ts";

export type ResolveQuestionFn = (id: string, answers: Record<string, string[]> | null) => void;

function secondsLeft(expiresAtMs: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - now) / 1000));
}

export function renderQuestionCards(
  prompts: QuestionPrompt[],
  onResolve: ResolveQuestionFn | undefined,
  now: number = Date.now(),
) {
  if (prompts.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-question-cards" role="alertdialog" aria-live="polite">
      ${repeat(
        prompts,
        (p) => p.id,
        (p) => {
          const tappable = isTappableQuestion(p);
          const item = p.questions[0];
          const answer = (labels: string[]) => onResolve?.(p.id, { [item.questionId]: labels });
          return html`
            <div class="chat-question-card" data-question-id=${p.id}>
              <div class="chat-question-card__head">
                <span class="chat-question-card__badge">${t("chat.question.badge")}</span>
                <span class="chat-question-card__title">${item.header}</span>
                <span class="chat-question-card__timer" title=${t("chat.question.expiresHint")}>
                  ${t("chat.question.expiresIn").replace("{s}", String(secondsLeft(p.expiresAtMs, now)))}
                </span>
              </div>
              <div class="chat-question-card__text">${item.question}</div>
              ${tappable
                ? html`
                  <div class="chat-question-card__options">
                    ${item.options.map(
                      (opt) => html`
                        <button
                          class="chat-question-card__option"
                          type="button"
                          title=${opt.description ?? nothing}
                          @click=${() => answer([opt.label])}
                        >
                          <span class="chat-question-card__option-label">${opt.label}</span>
                          ${opt.description
                            ? html`<span class="chat-question-card__option-desc">${opt.description}</span>`
                            : nothing}
                        </button>
                      `,
                    )}
                  </div>
                `
                : html`
                  <div class="chat-question-card__hint">${t("chat.question.replyInComposer")}</div>
                `}
              <div class="chat-question-card__actions">
                <button
                  class="chat-question-card__skip"
                  type="button"
                  @click=${() => onResolve?.(p.id, null)}
                >${t("chat.question.skip")}</button>
              </div>
            </div>
          `;
        },
      )}
    </div>
  `;
}

// 便捷导出：聊天视图 resolve 回调用（app-chat-props 构造具体实现）
export { buildResolveParams };
