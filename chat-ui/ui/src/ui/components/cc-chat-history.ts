import { LitElement, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { customElement } from "lit/decorators.js";
import type { ChatItem, MessageGroup } from "../types/chat-types.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { computeSessionFileChanges, type FileChange } from "../chat/file-changes.ts";
import { renderMessageGroup } from "../chat/grouped-render.ts";
import { normalizeMessage, normalizeRoleForGrouping, isToolResultMessage } from "../chat/message-normalizer.ts";
import { extractTextCached } from "../chat/message-extract.ts";
import { getLocale, t } from "../i18n.ts";

// 「历史消息/工具时间线列表」独立组件（R41 Task 11）。
//
// 为什么抽组件：历史列表是聊天页最重的子树（≤200 条消息的 repeat + 分组 markdown
// 渲染）。抽空前它直接写在 renderChat 模板里，草稿敲击、连接态、流式帧等任何高频
// 更新都会让 OpenClawApp 重渲染并对它整棵重新求值。抽出后：
// 1. 只有本组件的视觉属性（消息数组/工具流/可见数/推理开关/身份/git 可用性）引用
//    变化才重求值历史子树（shouldUpdate 门控）；
// 2. buildChatItemsMemoized / computeSessionFileChangesMemoized 的调用点随消费方
//    迁入本组件——状态层无关更新连「跑一遍 memo 比较」都省在组件外。
//
// 分工契约（同 Task 10 的 <cc-chat-stream>）：
// - 流式气泡/思考指示归 <cc-chat-stream>（装配在本组件之后），子代理卡在更后；
// - 全部业务状态仍归 OpenClawApp（app-*.ts 模块不动），本组件只接 props、无自有状态；
// - 事件回调以属性传入：buildChatProps 每帧构造新闭包，回调属性每帧 identity 变化，
//   但 shouldUpdate 只按视觉属性放行——属性赋值本身不受 shouldUpdate 影响（Lit 只
//   跳过 render），事件触发时经 this.onXxx 拿到的始终是最新闭包，不会有旧引用问题
//   （如 onQuoteMessage 依赖的最新 draft）。
//
// 无 shadow DOM：全局样式（styles/chat.css）与 .chat-thread 上的事件委托（路径链接
// 点击/图片 lightbox 等 document 级 closest 委托）都依赖扁平 DOM；懒渲染
// （hydrateLazyDetailsBody）是 <details> 自身 @toggle 监听 + :scope 查询，不依赖父链。
@customElement("cc-chat-history")
export class CcChatHistory extends LitElement {
  static properties = {
    messages: { attribute: false },
    toolMessages: { attribute: false },
    visibleHistoryCount: { attribute: false },
    showReasoning: { attribute: false },
    assistantName: { attribute: false },
    assistantAvatar: { attribute: false },
    gitAvailable: { attribute: false },
    onOpenSidebar: { attribute: false },
    onQuoteMessage: { attribute: false },
    onResendError: { attribute: false },
  };

  messages: unknown[] = [];
  toolMessages: unknown[] = [];
  visibleHistoryCount = 0;
  // 外层按会话推理档位/思考开关推导后传入（派生需要 sessions 查询，状态归外层）
  showReasoning = false;
  assistantName = "";
  // 外层传入解析后的身份头像（assistantAvatar ?? assistantAvatarUrl）
  assistantAvatar: string | null = null;
  gitAvailable: boolean | null = null;
  onOpenSidebar?: (content: string) => void;
  onQuoteMessage?: (text: string) => void;
  onResendError?: (text: string, attachments?: ChatAttachment[]) => void;

  // 无 shadow DOM：复用全局样式与线程级既有事件委托；自定义元素默认 display 为
  // inline，不影响内部块级 .chat-group/.chat-divider 布局（与 cc-chat-stream 同理）。
  createRenderRoot() {
    return this;
  }

  // 视觉属性之外的变化（主要是每帧新闭包的回调）不触发重渲染。
  private static readonly VISUAL_PROPS = [
    "messages",
    "toolMessages",
    "visibleHistoryCount",
    "showReasoning",
    "assistantName",
    "assistantAvatar",
    "gitAvailable",
  ] as const;

  shouldUpdate(changed: Map<PropertyKey, unknown>): boolean {
    return CcChatHistory.VISUAL_PROPS.some((name) => changed.has(name));
  }

  render() {
    const chatItems = buildChatItemsMemoized({
      messages: this.messages,
      toolMessages: this.toolMessages,
      visibleHistoryCount: this.visibleHistoryCount,
    });
    // 本轮改动文件列表：按组扫描 tool cards 派生（详见 chat/file-changes.ts 头注）
    const fileChangesByGroup = computeSessionFileChangesMemoized(chatItems);
    const totalHistory = Array.isArray(this.messages) ? this.messages.length : 0;
    const isHydrating = this.visibleHistoryCount > 0 && this.visibleHistoryCount < totalHistory;
    return html`${repeat(
      chatItems,
      (item) => item.key,
      (item) => {
        if (item.kind === "divider") {
          return html`
            <div class="chat-divider" role="separator" data-ts=${String(item.timestamp)}>
              <span class="chat-divider__line"></span>
              <span class="chat-divider__label">${item.label}</span>
              <span class="chat-divider__line"></span>
            </div>
          `;
        }

        if (item.kind === "group") {
          return renderMessageGroup(item, {
            onOpenSidebar: this.onOpenSidebar,
            showReasoning: this.showReasoning,
            assistantName: this.assistantName,
            assistantAvatar: this.assistantAvatar,
            isHydrating,
            fileChanges: fileChangesByGroup.get(item.key),
            gitAvailable: this.gitAvailable,
            onQuoteMessage: this.onQuoteMessage,
            onResendError: this.onResendError,
          });
        }

        return nothing;
      },
    )}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cc-chat-history": CcChatHistory;
  }
}

// ── 历史条目构建与派生计算 memo（整体自 views/chat.ts 迁入，R41 Task 11）─────
// renderChat 每次 Lit 更新都曾经直接跑 buildChatItems + computeSessionFileChanges，
// 但绝大多数更新（draft 敲击、连接状态、计数器）messages/toolMessages 数组
// 引用不变（状态层一律重赋值、从不原地改，见 controllers/chat.ts /
// app-tool-stream.ts）。按数组引用 + 相关标量浅比较做 memo，全部相同直接复用。
// R41 Task 10：stream/streamStartedAt/tasks/runActive/sessionKey 已从比较键移除——
// 流式条目与子代理卡移出 buildChatItems（分别由 <cc-chat-stream> / renderChat
// 直接渲染），每帧的 stream delta 不再让 ≤200 条历史全量重建。
// R41 Task 11：调用点迁入 <cc-chat-history>——外层高频更新连 memo 比较都不跑，
// 组件 shouldUpdate 未放行时整棵历史子树（含 repeat）不再被求值。

const CHAT_HISTORY_RENDER_LIMIT = 200;

// 历史构建输入（buildChatItems 只消费这三个字段；窄签名便于组件直接调用）
type ChatHistoryInput = {
  messages: unknown[];
  toolMessages: unknown[];
  visibleHistoryCount: number;
};

function buildChatItems(input: ChatHistoryInput): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const history = Array.isArray(input.messages) ? input.messages : [];
  const tools = Array.isArray(input.toolMessages) ? input.toolMessages : [];
  const visibleHistoryCount =
    input.visibleHistoryCount > 0
      ? Math.min(input.visibleHistoryCount, CHAT_HISTORY_RENDER_LIMIT, history.length)
      : Math.min(history.length, CHAT_HISTORY_RENDER_LIMIT);
  const historyStart = Math.max(0, history.length - visibleHistoryCount);
  if (historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: t("chat.historyTruncated")
          .replace("{n}", String(visibleHistoryCount))
          .replace("{m}", String(historyStart)),
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = normalizeMessage(msg);
    const raw = msg as Record<string, unknown>;
    const marker = raw.__openclaw as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: t("chat.compaction"),
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  // toolMessages 本身是摊平的时间线（由 app-tool-stream.ts::syncToolStreamMessages 构造）：
  // 依次包含 leadingSegment 文本 / tool call（result 已并入，R83），作为普通 message
  // 追加即可。工具调用/结果默认显示（渲染层折叠成 summary，点击展开），不依赖
  // showThinking 开关；showThinking 只控制思考内容的展示。
  for (let i = 0; i < tools.length; i++) {
    items.push({
      kind: "message",
      // tool 消息 key 用固定命名空间基数，不与 history.length 耦合：
      // buildToolCallMessage/leadingSegment 消息无顶层 toolCallId/messageId，
      // 走 messageKey 的 index 兑底分支，若用动态偏移，run 期间 chatMessages
      // 追加（乐观 user 消息/错误卡）会让全部 tool 卡片 key 平移 → lit repeat
      // 整批重建（hljs 重高亮、details 折叠态丢失）。history 渲染上限远小于
      // 该基数，两个命名空间不会撞车。
      key: messageKey(tools[i], i + 1_000_000_000),
      message: tools[i],
    });
  }

  // R41 Task 10：流式气泡（含空白时的思考指示）与子代理等待卡不再进 chatItems，
  // 改由 renderChat 线程尾部的 <cc-chat-stream> / renderSubagentCards 直接装配：
  // 每帧的流式 delta 不再 invalidate 本 memo，历史部分流式期间保持命中。
  return groupMessages(mergeToolResultHistory(items));
}

// ── R83：历史 toolResult 消息合并进对应 assistant toolCall 内容块 ──
// gateway transcript 里一次工具调用是两条消息（assistant 带 toolCall block +
// toolResult 消息带输出）。流式路径已在 app-tool-stream 合并；这里把历史也合并成
// 同一形态，保证「一次调用一张卡（输入+输出）」在流式与历史渲染一致。
// 合并方式：把 toolResult 的 text/isError/toolErrorSummary/exitCode/diffStat 写到
// 匹配的 toolCall block 上（消息浅拷贝，不改动 gateway 缓存里的原对象），并从时间线
// 移除该 toolResult 消息。匹配优先 block.id === toolCallId，兜底按工具名就近匹配；
// 无匹配的孤儿 result 保留原样（走既有独立渲染路径）。
type OpenCallSlot = { outIdx: number; blockIdx: number; name: string };

function isCallBlock(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const kind = (typeof (value as Record<string, unknown>).type === "string"
    ? ((value as Record<string, unknown>).type as string)
    : ""
  ).toLowerCase();
  return ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind);
}

function mergeToolResultHistory(items: ChatItem[]): ChatItem[] {
  const hasAnyToolResult = items.some((item) => {
    if (item.kind !== "message") {
      return false;
    }
    const m = item.message as Record<string, unknown>;
    return isToolResultMessage(m) || typeof m.toolCallId === "string";
  });
  if (!hasAnyToolResult) {
    return items;
  }

  const out: ChatItem[] = [];
  const openById = new Map<string, OpenCallSlot>();
  const openByName = new Map<string, OpenCallSlot[]>();

  const registerCallBlocks = (item: ChatItem & { kind: "message" }, outIdx: number) => {
    const content = (item.message as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      return;
    }
    for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
      const block = content[blockIdx];
      if (!isCallBlock(block)) {
        continue;
      }
      // 已并入 result 的块（text 字段存在）不再登记
      if (typeof block.text === "string") {
        continue;
      }
      const name = typeof block.name === "string" ? block.name : "tool";
      const slot: OpenCallSlot = { outIdx, blockIdx, name };
      if (typeof block.id === "string" && block.id) {
        openById.set(block.id, slot);
      }
      const byName = openByName.get(name);
      if (byName) {
        byName.push(slot);
      } else {
        openByName.set(name, [slot]);
      }
    }
  };

  for (const item of items) {
    if (item.kind !== "message") {
      out.push(item);
      continue;
    }
    const m = item.message as Record<string, unknown>;
    const isToolResultMsg = isToolResultMessage(m) || typeof m.toolCallId === "string";
    if (isToolResultMsg) {
      const slot =
        (typeof m.toolCallId === "string" && openById.get(m.toolCallId)) ||
        (typeof m.toolName === "string" ? openByName.get(m.toolName)?.shift() : undefined) ||
        openByName.get("tool")?.shift();
      if (!slot) {
        // 孤儿 result（无对应 call）：保留原消息走既有渲染路径
        out.push(item);
        continue;
      }
      const target = out[slot.outIdx] as ChatItem & { kind: "message" };
      const targetMsg = target.message as Record<string, unknown>;
      const content = Array.isArray(targetMsg.content)
        ? (targetMsg.content as unknown[]).slice()
        : [];
      const block = { ...(content[slot.blockIdx] as Record<string, unknown>) };
      const text = extractTextCached(m) ?? "";
      block.text = text;
      if (m.isError === true) {
        block.isError = true;
      }
      if (typeof m.toolErrorSummary === "string" && m.toolErrorSummary.trim()) {
        block.toolErrorSummary = m.toolErrorSummary;
      }
      if (typeof m.exitCode === "number" && Number.isInteger(m.exitCode)) {
        block.exitCode = m.exitCode;
      }
      const diffStat = m.diffStat;
      if (diffStat && typeof diffStat === "object") {
        block.diffStat = diffStat;
      }
      content[slot.blockIdx] = block;
      out[slot.outIdx] = {
        ...target,
        // 消息浅拷贝：不改动 gateway 缓存里的原对象（WeakMap 派生缓存按引用隔离，
        // 合并产物只在本组件 memo 生命周期内存在）
        message: { ...targetMsg, content },
      };
      if (typeof m.toolCallId === "string") {
        openById.delete(m.toolCallId);
      }
      continue;
    }
    out.push(item);
    registerCallBlocks(item, out.length - 1);
  }
  return out;
}

type ChatItemsMemo = {
  messages: unknown[];
  toolMessages: unknown[];
  visibleHistoryCount: number;
  locale: string;
  result: Array<ChatItem | MessageGroup>;
};
let chatItemsMemo: ChatItemsMemo | null = null;

export function buildChatItemsMemoized(input: ChatHistoryInput): Array<ChatItem | MessageGroup> {
  const prev = chatItemsMemo;
  if (
    prev &&
    prev.messages === input.messages &&
    prev.toolMessages === input.toolMessages &&
    prev.visibleHistoryCount === input.visibleHistoryCount &&
    prev.locale === getLocale()
  ) {
    return prev.result;
  }
  const result = buildChatItems(input);
  chatItemsMemo = {
    messages: input.messages,
    toolMessages: input.toolMessages,
    visibleHistoryCount: input.visibleHistoryCount,
    locale: getLocale(),
    result,
  };
  return result;
}

// fileChanges 按 chatItems 数组引用 memo：buildChatItems 命中 memo 时此处也直接复用。
let fileChangesMemo: {
  chatItems: Array<ChatItem | MessageGroup>;
  result: Map<string, FileChange[]>;
} | null = null;

export function computeSessionFileChangesMemoized(
  chatItems: Array<ChatItem | MessageGroup>,
): Map<string, FileChange[]> {
  if (fileChangesMemo && fileChangesMemo.chatItems === chatItems) {
    return fileChangesMemo.result;
  }
  const result = computeSessionFileChanges(
    chatItems.filter((item): item is MessageGroup => item.kind === "group"),
  );
  fileChangesMemo = { chatItems, result };
  return result;
}

// 分组用 role：tool 和 assistant 归为同一组，共享 avatar 和 footer
function groupingRole(role: string): string {
  const r = normalizeRoleForGrouping(role);
  return r === "tool" ? "assistant" : r;
}

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const gRole = groupingRole(role);
    const timestamp = normalized.timestamp || Date.now();

    if (!currentGroup || groupingRole(currentGroup.role) !== gRole) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${gRole}:${item.key}`,
        role: gRole,
        messages: [{ message: item.message, key: item.key }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({ message: item.message, key: item.key });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    return `tool:${toolCallId}`;
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
