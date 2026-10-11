import { extractText } from "../chat/message-extract.ts";

export type ChatStreamDeltaInput = {
  currentText: string;
  deltaText?: string;
  replace?: boolean;
  message?: unknown;
  frozenPrefix?: string;
  /**
   * R5：交叉校验连续失败计数（调用方在 run 状态上持久化，run 终态清零）。
   * 缺省按 0 处理。
   */
  mismatchCount?: number;
};

export type ChatStreamDeltaResult = {
  text: string;
  accepted: boolean;
  source: "deltaText" | "snapshot";
  replaced: boolean;
  /**
   * R3：replace 帧的全文不再以 frozenPrefix 开头 → 之前冻结进 toolStream 的
   * leadingSegment 已被本次重生成改写。消费方据此作废被重写的冻结段并清空
   * frozenPrefix，否则旧段与正文同屏双份。
   */
  invalidatesFrozenPrefix?: boolean;
  /** R5：回写调用方的交叉校验连续失败计数（校验通过或未校验时为 0/缺省）。 */
  mismatchCount?: number;
};

// R5：交叉校验失配按帧计数（连续失配 = 基线漂移观测值，随 run 终态/新 run 清零）。
// 失配帧的处理规则：前向延伸走 R88 self-heal 即刻 resync；非前向（倒退/分叉）
// 一律保守追加、绝不回跳已上屏文本——漂移的收敛靠后续帧重新对齐或终态历史刷新。
// （旧版此处有「连续 N 帧强制 resync」分支，实为不可达死代码：凡满足前向条件的
// 失配帧更早被 R88 self-heal 收走，非前向 resync 又会回跳，两头都不成立，已删。）

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
      if (prefix && !input.deltaText.startsWith(prefix)) {
        // R3：重生成文本不再包含已冻结前缀——之前冻结的 leadingSegment 已被改写，
        // 整段采用新文本并发出作废信号（消费方清掉被重写的冻结段 + frozenPrefix，
        // 否则旧段留在 toolStream 时间线上与新正文双份显示）。
        return {
          text: input.deltaText,
          accepted: true,
          source: "deltaText",
          replaced: true,
          invalidatesFrozenPrefix: true,
          mismatchCount: 0,
        };
      }
      const text = prefix ? input.deltaText.slice(prefix.length) : input.deltaText;
      return {
        text,
        accepted: true,
        source: "deltaText",
        replaced: true,
        mismatchCount: 0,
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
            mismatchCount: 0,
          };
        }
        // R5：快照既对不上追加结果、又不是本地基线的前向延伸（基线已彻底偏离
        // 内核真值）——一律保守追加、绝不回跳已上屏文本（倒退/分叉的 resync 会与
        // 时间线上的冻结段同屏双份闪现）。失配按帧计数（连续失配 = 漂移观测值，run
        // 终态/新 run 清零）；前向延伸的失配帧更早被上方 R88 self-heal 即刻收敛，
        // 非前向失配等后续帧重新对齐或终态/历史刷新整体回归。
        const nextMismatch = (input.mismatchCount ?? 0) + 1;
        return {
          text: current + input.deltaText,
          accepted: true,
          source: "deltaText",
          replaced: false,
          mismatchCount: nextMismatch,
        };
      }
      return {
        text: current + input.deltaText,
        accepted: true,
        source: "deltaText",
        replaced: false,
        mismatchCount: 0,
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
  // 旧版快照路径与 deltaText-replace 分支同契约：全文不再以 frozenPrefix 开头
  // 说明工具前文本已被内核改写（重生成/换基线），冻结段留任会与新正文双份。
  const beyondPrefix = Boolean(prefix) && !fullText.startsWith(prefix);
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
      ...(beyondPrefix ? { invalidatesFrozenPrefix: true } : {}),
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
    ...(beyondPrefix ? { invalidatesFrozenPrefix: true } : {}),
  };
}
