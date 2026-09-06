import { extractText } from "../chat/message-extract.ts";

export type ChatStreamDeltaInput = {
  currentText: string;
  deltaText?: string;
  replace?: boolean;
  message?: unknown;
  frozenPrefix?: string;
};

export type ChatStreamDeltaResult = {
  text: string;
  accepted: boolean;
  source: "deltaText" | "snapshot";
  replaced: boolean;
};

/**
 * Reduce one gateway chat delta into the currently visible assistant segment.
 *
 * Protocol v4 exposes explicit deltaText/replace fields. Older gateways only
 * expose a cumulative message snapshot, so the snapshot path remains as a
 * compatibility fallback. A snapshot that moves backwards is rejected unless
 * the gateway explicitly marks it as a replacement.
 */
export function reduceChatStreamDelta(input: ChatStreamDeltaInput): ChatStreamDeltaResult | null {
  const current = input.currentText ?? "";
  if (typeof input.deltaText === "string") {
    const text = input.replace ? input.deltaText : current + input.deltaText;
    return {
      text,
      accepted: true,
      source: "deltaText",
      replaced: input.replace === true,
    };
  }

  const fullText = extractText(input.message);
  if (typeof fullText !== "string") {
    return null;
  }

  const prefix = input.frozenPrefix ?? "";
  let next = fullText;
  if (prefix && fullText.startsWith(prefix)) {
    next = fullText.slice(prefix.length);
  }

  if (input.replace === true) {
    return {
      text: next,
      accepted: true,
      source: "snapshot",
      replaced: true,
    };
  }

  if (current && next.length < current.length) {
    return {
      text: current,
      accepted: false,
      source: "snapshot",
      replaced: false,
    };
  }

  return {
    text: next,
    accepted: true,
    source: "snapshot",
    replaced: false,
  };
}
