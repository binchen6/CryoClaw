/**
 * Chat rendering types used by the message normalizer,
 * grouped render, tool cards, and chat view.
 */

export type MessageContentItem = {
  type: string;
  text?: string;
  name?: string;
  arguments?: unknown;
  args?: unknown;
  toolCallId?: string;
  tool_call_id?: string;
  [key: string]: unknown;
};

export type NormalizedMessage = {
  role: string;
  content: MessageContentItem[];
  timestamp: number;
  id?: string;
  toolCallId?: string;
  toolName?: string;
  raw?: unknown;
  [key: string]: unknown;
};

export type ChatItem =
  | { kind: "message"; key: string; message: unknown }
  | { kind: "divider"; key: string; label: string; timestamp: number }
  | { kind: "stream"; key: string; text: string; startedAt: number }
  | { kind: "reading-indicator"; key: string };

export type MessageGroup = {
  kind: "group";
  key: string;
  role: string;
  messages: Array<{ message: unknown; key: string }>;
  timestamp: number;
  isStreaming: boolean;
};

export type ToolCard = {
  kind: "call" | "result";
  name: string;
  args?: unknown;
  text?: string;
  output?: unknown;
  error?: string;
  // 流式进行中的 call（有 call 无 result，app-tool-stream 在 callMessage 上标 pending）
  pending?: boolean;
  [key: string]: unknown;
};
