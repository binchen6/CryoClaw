/**
 * Message normalization utilities for chat rendering.
 */

import type { NormalizedMessage, MessageContentItem } from "../types/chat-types.ts";

/** Code Mode persists catalog calls outside model context as owned nested-tool
 * messages. Present them through the same tool-result path as direct calls. */
export function unwrapNestedToolMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const m=message as Record<string,unknown>;
  if(m.role!=="custom" || m.customType!=="openclaw.nested-tool.v1" || m.display===false) return message;
  const d=m.details as Record<string,unknown>|undefined;
  const result=d?.result as Record<string,unknown>|undefined;
  if(d && typeof d.toolName==="string" && result && Array.isArray(result.content)) return {...m,role:"toolResult",toolName:d.toolName,toolCallId:d.toolCallId,
    content:result.content,details:result.details,arguments:d.input,isError:m.isError===true || d.isError===true || result.isError===true,
    timestamp:typeof d.timestamp==="number"?d.timestamp:m.timestamp};
  // chat.history deliberately removes arbitrary result details. Its public
  // nested-tool projection still pairs the original call with a completed result.
  const blocks=Array.isArray(m.content)?m.content as Record<string,unknown>[]:[];
  const call=blocks.find(b=>b.type==="toolCall" && typeof b.id==="string");
  const outcome=blocks.find(b=>b.type==="toolResult" && b.toolCallId===call?.id);
  if(!call || !outcome)return message;
  const details=deliveryDetailsForCall(call,outcome);
  return {...m,role:"assistant",content:[{...call,text:Array.isArray(outcome.content)?outcome.content.filter(b=>b?.type==="text").map(b=>b.text??"").join("\n"):"",
    isError:outcome.isError===true,...details?{details}:{}}]};
}

/** A successful owned invocation validates every input file before returning.
 * Recover only its explicit input when the public projection strips metadata. */
export function deliveryDetailsForCall(call: Record<string,unknown>, result: Record<string,unknown>): unknown {
  if(call.name!=="cryoclaw_deliver_files" || result.isError!==false || result.pending===true || result.toolName!==call.name ||
    typeof call.id!=="string" || result.toolCallId!==call.id)return undefined;
  if(result.details && typeof result.details==="object")return result.details;
  const args=(call.arguments??call.args) as {files?:unknown}|undefined;
  if(!args || !Array.isArray(args.files) || args.files.length<1 || args.files.length>12)return undefined;
  return {cryoclawDeliverables:{version:1,files:args.files}};
}

/**
 * Normalize a raw message object into a consistent structure.
 */
export function normalizeMessage(message: unknown): NormalizedMessage {
  const m = message as Record<string, unknown>;
  let role = typeof m.role === "string" ? m.role : "unknown";

  // Detect tool messages by common gateway shapes.
  // Some tool events come through as assistant role with tool_* items in the content array.
  const hasToolId = typeof m.toolCallId === "string" || typeof m.tool_call_id === "string";

  const contentRaw = m.content;
  const contentItems = Array.isArray(contentRaw) ? contentRaw : null;
  const hasToolContent =
    Array.isArray(contentItems) &&
    contentItems.some((item) => {
      const x = item as Record<string, unknown>;
      const t = (typeof x.type === "string" ? x.type : "").toLowerCase();
      return t === "toolresult" || t === "tool_result";
    });

  const hasToolName = typeof m.toolName === "string" || typeof m.tool_name === "string";

  if (hasToolId || hasToolContent || hasToolName) {
    role = "toolResult";
  }

  // Extract content
  let content: MessageContentItem[] = [];

  if (typeof m.content === "string") {
    content = [{ type: "text", text: m.content }];
  } else if (Array.isArray(m.content)) {
    content = m.content.map((item: Record<string, unknown>) => ({
      type: (item.type as MessageContentItem["type"]) || "text",
      text: item.text as string | undefined,
      name: item.name as string | undefined,
      args: item.args || item.arguments,
    }));
  } else if (typeof m.text === "string") {
    content = [{ type: "text", text: m.text }];
  }

  const timestamp = typeof m.timestamp === "number" ? m.timestamp : Date.now();
  const id = typeof m.id === "string" ? m.id : undefined;

  return { role, content, timestamp, id };
}

/**
 * Normalize role for grouping purposes.
 */
export function normalizeRoleForGrouping(role: string): string {
  const lower = role.toLowerCase();
  // Preserve original casing when it's already a core role.
  if (role === "user" || role === "User") {
    return role;
  }
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "system") {
    return "system";
  }
  // Keep tool-related roles distinct so the UI can style/toggle them.
  if (
    lower === "toolresult" ||
    lower === "tool_result" ||
    lower === "tool" ||
    lower === "function"
  ) {
    return "tool";
  }
  return role;
}

/**
 * Check if a message is a tool result message based on its role.
 */
export function isToolResultMessage(message: unknown): boolean {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  return role === "toolresult" || role === "tool_result";
}
