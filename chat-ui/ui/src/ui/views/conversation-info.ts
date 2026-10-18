import { html, nothing } from "lit";
import { getLocale } from "../i18n.ts";
import { icons } from "../icons.ts";
import { extractMessageMediaAttachments } from "../chat/media-attachments.ts";
import { selectSubagentCards } from "../chat/subagent-status.ts";
import type { ChatProps } from "./chat.ts";

let open = false;
let leaving = false;
let exitTimer: ReturnType<typeof setTimeout> | undefined;
export function conversationInfoOpen() { return open && !leaving; }
export function toggleConversationInfo(update: () => void) {
  if (exitTimer) clearTimeout(exitTimer);
  if (!open || leaving) { open = true; leaving = false; update(); return; }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { open = false; update(); return; }
  leaving = true; update();
  exitTimer = setTimeout(() => { open = false; leaving = false; exitTimer = undefined; update(); }, 160);
}
let sourceMessages: unknown[] | undefined;
let sourceFiles: ReturnType<typeof extractMessageMediaAttachments> = [];
function sources(messages: unknown[]) {
  if (sourceMessages === messages) return sourceFiles;
  sourceMessages = messages;
  const seen = new Set<string>();
  sourceFiles = messages.flatMap(message => extractMessageMediaAttachments(message)).filter(file => {
    if (seen.has(file.path)) return false; seen.add(file.path); return true;
  });
  return sourceFiles;
}
export function renderConversationInfo(props: ChatProps) {
  if (!open) return nothing;
  const zh = getLocale().startsWith("zh");
  const agents = selectSubagentCards(props.sessions?.sessions, props.sessionKey, Date.now(), Infinity);
  const files = sources(props.messages);
  return html`<aside id="conversation-info" class="chat-conversation-info ${leaving ? "is-leaving" : ""}" aria-label=${zh ? "会话信息" : "Conversation information"}
    @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); toggleConversationInfo(() => props.onRequestUpdate?.()); } }}>
    <header><strong>${zh ? "会话信息" : "Conversation information"}</strong><button type="button" class="icon-btn" aria-label=${zh ? "关闭会话信息" : "Close conversation information"} @click=${() => toggleConversationInfo(() => props.onRequestUpdate?.())}>${icons.x}</button></header>
    <section><h3>${zh ? "工作区" : "Workspace"}</h3><button type="button" class="chat-conversation-info__workspace" @click=${props.onOpenGitView}>${icons.folder}<span title=${props.workspacePath ?? ""}>${props.workspaceName || (zh ? "默认工作区" : "Default workspace")}</span>${icons.chevronRight}</button></section>
    <section><h3>${zh ? "子智能体" : "Subagents"}<span>${agents.length}</span></h3>
      ${agents.length ? agents.map(agent => html`<button type="button" class="chat-conversation-info__row" @click=${() => props.onSessionKeyChange(agent.sessionKey)}><span>${agent.title}</span><small>${agent.active ? (zh ? "运行中" : "Running") : agent.status}</small></button>`) : html`<p>${zh ? "当前会话没有子智能体" : "No subagents in this conversation"}</p>`}
    </section>
    <section><h3>${zh ? "来源文件" : "Source files"}<span>${files.length}</span></h3>
      ${files.length ? html`<ul>${files.map(file => html`<li title=${file.path}>${icons.fileText}<span>${file.fileName}</span></li>`)}</ul>` : html`<p>${zh ? "发送的文件会显示在这里" : "Files sent in this conversation appear here"}</p>`}
    </section>
  </aside>`;
}
