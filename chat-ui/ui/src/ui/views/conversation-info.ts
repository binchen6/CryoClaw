import { html, nothing } from "lit";
import { getLocale } from "../i18n.ts";
import { icons } from "../icons.ts";
import { extractMessageMediaAttachments } from "../chat/media-attachments.ts";
import { selectSubagentCards } from "../chat/subagent-status.ts";
import type { ChatProps } from "./chat.ts";

let open = false;
let leaving = false;
let exitTimer: ReturnType<typeof setTimeout> | undefined;
// 打开者与全局监听：面板是 contextbar 上的停靠式浮层，Esc / 点外部 / X 三条关闭路径
// 共用同一条退场，并把焦点交回信息按钮（键盘用户不会落到 body）。
let opener: HTMLElement | null = null;
let outsideCloser: ((ev: MouseEvent) => void) | null = null;
let escapeCloser: ((ev: KeyboardEvent) => void) | null = null;
export function conversationInfoOpen() { return open && !leaving; }
function detachClosers() {
  if (outsideCloser) { document.removeEventListener("click", outsideCloser, true); outsideCloser = null; }
  if (escapeCloser) { document.removeEventListener("keydown", escapeCloser, true); escapeCloser = null; }
}
function attachClosers(update: () => void) {
  detachClosers();
  // 捕获阶段 + 延迟一帧注册：打开它的那次点击/按键不会被自己立刻关掉。
  requestAnimationFrame(() => {
    if (!open) return;
    outsideCloser = (ev: MouseEvent) => {
      const root = document.getElementById("conversation-info");
      const target = ev.target as HTMLElement | null;
      if (root && target && (root.contains(target) || opener?.contains(target))) return;
      toggleConversationInfo(update);
    };
    escapeCloser = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.isComposing || !open) return;
      ev.preventDefault();
      ev.stopPropagation();
      toggleConversationInfo(update);
    };
    document.addEventListener("click", outsideCloser, true);
    document.addEventListener("keydown", escapeCloser, true);
  });
}
export function toggleConversationInfo(update: () => void, trigger: HTMLElement | null = null) {
  if (exitTimer) clearTimeout(exitTimer);
  if (!open || leaving) {
    open = true;
    leaving = false;
    if (trigger?.isConnected) opener = trigger;
    attachClosers(update);
    update();
    return;
  }
  detachClosers();
  const target = opener?.isConnected ? opener : null;
  opener = null;
  const restore = () => requestAnimationFrame(() => target?.focus());
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { open = false; update(); restore(); return; }
  leaving = true; update();
  exitTimer = setTimeout(() => { open = false; leaving = false; exitTimer = undefined; update(); restore(); }, 160);
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
  return html`<aside id="conversation-info" class="chat-conversation-info ${leaving ? "is-leaving" : ""}" aria-label=${zh ? "会话信息" : "Conversation information"}>
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
