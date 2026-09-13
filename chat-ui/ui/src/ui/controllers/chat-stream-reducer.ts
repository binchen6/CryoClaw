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
 *
 * Kernel contract (server-chat resolveBroadcastDelta, re-verified on 2026.9.3):
 * - append frame: deltaText is the suffix grown since the last broadcast;
 *   `message` always carries the FULL cumulative text as a cross-check.
 * - first frame / rewind frame (provider fallback regeneration, thinking
 *   rewrite): deltaText carries the FULL run text and is marked replace:true.
 * Because full-text frames include the tool-frozen prefix, replace frames
 * strip frozenPrefix exactly like the legacy snapshot path; append frames
 * never strip (they are already post-prefix suffixes).
 *
 * R88 self-heal: append frames now cross-check against the full snapshot
 * exactly like the official control-ui merge (DT): when
 * `current + deltaText` no longer matches `message`, the frame was preceded
 * by a lost/dropped frame (seq gap, reconnect adoption, zombie-filter reject)
 * and we resync from the full snapshot instead of appending onto a corrupted
 * base. Without this, a single lost frame corrupts every subsequent frame
 * until the next replace frame.
 */
export function reduceChatStreamDelta(input: ChatStreamDeltaInput): ChatStreamDeltaResult | null {
  const current = input.currentText ?? "";
  if (typeof input.deltaText === "string") {
    if (input.replace) {
      const prefix = input.frozenPrefix ?? "";
      const text =
        prefix && input.deltaText.startsWith(prefix) ? input.deltaText.slice(prefix.length) : input.deltaText;
      return {
        text,
        accepted: true,
        source: "deltaText",
        replaced: true,
      };
    }
    // R88 self-heal: cross-check the appended result against the full snapshot.
    // The snapshot is the run-cumulative text (including frozenPrefix), so the
    // expected visible text is its suffix of length deltaText.length.
    const fullText = input.message == null ? null : extractText(input.message);
    if (typeof fullText === "string") {
      const prefix = input.frozenPrefix ?? "";
      const base = prefix + current;
      const expectedLen = input.deltaText.length;
      const aligned =
        fullText.length >= expectedLen &&
        fullText.slice(fullText.length - expectedLen) === input.deltaText &&
        fullText.slice(0, fullText.length - expectedLen) === base;
      if (!aligned) {
        // Self-heal only when the snapshot is a forward extension of the local
        // base (prefix+current): that is the lost-frame shape (a dropped frame
        // left unseen content between current and deltaText). Unrelated or
        // shorter snapshots (stale reads, anomalies) must not move the stream
        // backwards — keep the local append and let a later frame re-align.
        if (fullText.startsWith(base)) {
          let resync = fullText;
          if (prefix && resync.startsWith(prefix)) {
            resync = resync.slice(prefix.length);
          }
          return {
            text: resync,
            accepted: true,
            source: "snapshot",
            replaced: true,
          };
        }
      }
      return {
        text: current + input.deltaText,
        accepted: true,
        source: "deltaText",
        replaced: false,
      };
    }
    return {
      text: current + input.deltaText,
      accepted: true,
      source: "deltaText",
      replaced: false,
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
