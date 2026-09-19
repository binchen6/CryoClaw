import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import type { AssistantIdentity } from "../assistant-identity.ts";
import { renderLiveThinkingGroup, renderReadingIndicatorGroup, renderStreamingGroup } from "../chat/grouped-render.ts";

// 「当前正在打字的流式气泡」独立组件（R41 Task 10）。
//
// 为什么抽组件：chatStream 每个 flush 帧累计 delta，此前它既参与 renderChat 模板、
// 又是 buildChatItemsMemoized 的比较键——每帧都让整棵 OpenClawApp 模板树重求值、
// 并全量重建 ≤200 条历史的 chatItems。抽出后：
// 1. 流式高频更新只命中本组件的 render()，历史 repeat 与周边视图不再每帧重建；
// 2. buildChatItemsMemoized 的比较键去掉 stream/streamStartedAt，历史部分流式期间保持命中。
//
// 契约：状态仍归 OpenClawApp（app-*.ts 模块不动），本组件只接 props、无自有业务状态；
// 事件回调以属性传入。注意 buildChatProps 每帧构造新闭包，回调属性每帧 identity 变化，
// 但 shouldUpdate 只按视觉属性放行——属性赋值本身不受 shouldUpdate 影响（Lit 只跳过
// render），事件触发时经 this.onXxx 调用拿到的始终是最新闭包，不会有旧引用问题。
@customElement("oc-chat-stream")
export class OcChatStream extends LitElement {
  static properties = {
    stream: { type: String },
    thinkingStream: { type: String },
    narrationText: { type: String },
    streamStartedAt: { attribute: false },
    assistantName: { attribute: false },
    assistantAvatar: { attribute: false },
    activeToolName: { attribute: false },
    subagentWaiting: { attribute: false },
    onOpenSidebar: { attribute: false },
  };

  stream: string | null = null;
  // R88 思考过程流式：当前 reasoning phase 全量文本（null = 无）
  thinkingStream: string | null = null;
  // R88 中途解说流式：内核 preamble item 的 progressText（null = 无）
  narrationText: string | null = null;
  streamStartedAt: number | null = null;
  assistantName = "";
  assistantAvatar: string | null = null;
  // 阶段感知提示用（工具执行中显示工具名；无工具时为「思考中」）
  activeToolName: string | null = null;
  // 主 run 等待子代理时思考指示改显示等待文案（与原 reading-indicator 条目语义一致）
  subagentWaiting = false;
  onOpenSidebar?: (content: string) => void;

  // 无 shadow DOM：复用全局样式（styles/chat.css 的 .chat-group 等）与
  // 线程级既有事件委托；自定义元素默认 display 不影响内部块级 .chat-group 布局。
  createRenderRoot() {
    return this;
  }

  // 视觉属性之外的变化（主要是每帧新闭包的回调）不触发重渲染。
  private static readonly VISUAL_PROPS = [
    "stream",
    "thinkingStream",
    "narrationText",
    "streamStartedAt",
    "assistantName",
    "assistantAvatar",
    "activeToolName",
    "subagentWaiting",
  ] as const;

  shouldUpdate(changed: Map<PropertyKey, unknown>): boolean {
    return OcChatStream.VISUAL_PROPS.some((name) => changed.has(name));
  }

  // R90：实时思考区展开时正文自动滚底——每帧新思考文本到达后把 scrollTop 钉在
  // scrollHeight，用户手动上滚查看早前内容时不强制拉回（仅在有新帧时贴底一次，
  // 与聊天线程的贴底语义不同：思考区是只读流水，钉底体验优先）。
  protected updated(changed: Map<PropertyKey, unknown>): void {
    if (!changed.has("thinkingStream")) {
      return;
    }
    const details = this.querySelector<HTMLDetailsElement>("details.chat-thinking-live");
    if (!details?.open) {
      return;
    }
    const body = details.querySelector<HTMLElement>(".chat-thinking-live__text");
    if (body) {
      body.scrollTop = body.scrollHeight;
    }
  }

  render() {
    if (this.stream === null && this.thinkingStream === null && this.narrationText === null) {
      return nothing;
    }
    const identity: AssistantIdentity = {
      name: this.assistantName,
      avatar: this.assistantAvatar,
    };
    // 与原 buildChatItems 分支一一对应：非空文本走流式气泡；
    // 仅空白（等待首帧/工具间隙空串）走思考/阶段指示。
    // startedAt 缺省回退当前时间——与原实现每帧重建条目时 Date.now() 求值等价。
    if ((this.stream ?? "").trim().length > 0) {
      return renderStreamingGroup(
        this.stream!,
        this.streamStartedAt ?? Date.now(),
        this.onOpenSidebar,
        identity,
        { thinkingStream: this.thinkingStream, narrationText: this.narrationText },
      );
    }
    // R88：正文未到但思考/解说已在流式——实时思考区替代纯打点指示
    if ((this.thinkingStream ?? "").trim().length > 0 || (this.narrationText ?? "").trim().length > 0) {
      return renderLiveThinkingGroup(
        identity,
        this.thinkingStream,
        this.narrationText,
        this.activeToolName,
        this.subagentWaiting,
      );
    }
    return renderReadingIndicatorGroup(identity, this.activeToolName, this.subagentWaiting);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "oc-chat-stream": OcChatStream;
  }
}
