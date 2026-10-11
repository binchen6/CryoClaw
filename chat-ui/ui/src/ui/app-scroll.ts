/** Distance (px) from the bottom within which we consider the user "near bottom". */
const NEAR_BOTTOM_THRESHOLD = 450;

type ScrollHost = {
  updateComplete: Promise<unknown>;
  querySelector: (selectors: string) => Element | null;
  style: CSSStyleDeclaration;
  chatScrollFrame: number | null;
  chatScrollTimeout: number | null;
  // 单调递增调度代际号：updateComplete.then 闭包不可取消，同帧两次调度会产生
  // 双重滚动且 rAF 句柄互踩丢失（旧闭包覆盖新句柄，新调度反而取消不掉旧帧）。
  // 回调落地前比对代际，过期即返回。
  chatScrollGeneration: number;
  chatHasAutoScrolled: boolean;
  chatUserNearBottom: boolean;
  chatNewMessagesBelow: boolean;
};

export function scheduleChatScroll(host: ScrollHost, force = false, smooth = false) {
  if (host.chatScrollFrame) {
    cancelAnimationFrame(host.chatScrollFrame);
  }
  if (host.chatScrollTimeout != null) {
    clearTimeout(host.chatScrollTimeout);
    host.chatScrollTimeout = null;
  }
  const generation = ++host.chatScrollGeneration;
  const isStale = () => generation !== host.chatScrollGeneration;
  const pickScrollTarget = () => {
    const container = host.querySelector(".chat-thread") as HTMLElement | null;
    if (container) {
      const overflowY = getComputedStyle(container).overflowY;
      const canScroll =
        overflowY === "auto" ||
        overflowY === "scroll" ||
        container.scrollHeight - container.clientHeight > 1;
      if (canScroll) {
        return container;
      }
    }
    return (document.scrollingElement ?? document.documentElement) as HTMLElement | null;
  };
  // Wait for Lit render to complete, then scroll
  void host.updateComplete.then(() => {
    if (isStale()) {
      return; // 已被更新的调度取代（闭包不可取消，代际比对兜底）
    }
    host.chatScrollFrame = requestAnimationFrame(() => {
      if (isStale()) {
        return;
      }
      host.chatScrollFrame = null;
      const target = pickScrollTarget();
      if (!target) {
        return;
      }
      const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;

      // force=true only overrides when we haven't auto-scrolled yet (initial load).
      // After initial load, respect the user's scroll position.
      const effectiveForce = force && !host.chatHasAutoScrolled;
      const shouldStick =
        effectiveForce || host.chatUserNearBottom || distanceFromBottom < NEAR_BOTTOM_THRESHOLD;

      if (!shouldStick) {
        // User is scrolled up — flag that new content arrived below.
        host.chatNewMessagesBelow = true;
        return;
      }
      if (effectiveForce) {
        host.chatHasAutoScrolled = true;
      }
      const smoothEnabled =
        smooth &&
        (typeof window === "undefined" ||
          typeof window.matchMedia !== "function" ||
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      const scrollTop = target.scrollHeight;
      if (typeof target.scrollTo === "function") {
        target.scrollTo({ top: scrollTop, behavior: smoothEnabled ? "smooth" : "auto" });
      } else {
        target.scrollTop = scrollTop;
      }
      host.chatUserNearBottom = true;
      host.chatNewMessagesBelow = false;
      const retryDelay = effectiveForce ? 150 : 120;
      host.chatScrollTimeout = window.setTimeout(() => {
        host.chatScrollTimeout = null;
        if (isStale()) {
          return; // 重试落地前又有新调度：过期重试不得回写滚动位置
        }
        const latest = pickScrollTarget();
        if (!latest) {
          return;
        }
        const latestDistanceFromBottom =
          latest.scrollHeight - latest.scrollTop - latest.clientHeight;
        const shouldStickRetry =
          effectiveForce ||
          host.chatUserNearBottom ||
          latestDistanceFromBottom < NEAR_BOTTOM_THRESHOLD;
        if (!shouldStickRetry) {
          return;
        }
        latest.scrollTop = latest.scrollHeight;
        host.chatUserNearBottom = true;
      }, retryDelay);
    });
  });
}

export function handleChatScroll(host: ScrollHost, event: Event) {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) {
    return;
  }
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  host.chatUserNearBottom = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
  // Clear the "new messages below" indicator when user scrolls back to bottom.
  if (host.chatUserNearBottom) {
    host.chatNewMessagesBelow = false;
  }
}

export function resetChatScroll(host: ScrollHost) {
  // 代际自增使在途的调度闭包（then/rAF/timeout 均不可取消）全部过期——
  // 会话切换/手动回底后，旧会话残留的滚动回调不得再回写位置。
  host.chatScrollGeneration += 1;
  host.chatHasAutoScrolled = false;
  host.chatUserNearBottom = true;
  host.chatNewMessagesBelow = false;
}

// ── 切换会话不断流配套：滚动位置按会话记忆 ──
// 切走前保存旧会话 scrollTop，切回时还原（低成本版）。只记非贴底位置：贴底会话
// 切回保持 chatUserNearBottom=true 走既有 stick-to-bottom 链路（还原路径会把
// chatUserNearBottom 置 false，还原值又常被注水/CV 占位估算 clamp 到历史中部，
// 贴底跟流反而中断）。
// 已知取舍：切回后历史走渐进注水（首屏 20 条逐批补齐），注水完成前还原值可能被
// clamp（.chat-group 的 content-visibility 占位估算同向叠加）；长历史切回的精确
// 位置不保证，run 态无损才是本批次的主目标。

const sessionScrollPositions = new Map<string, number>();
const SESSION_SCROLL_POSITION_MAX = 20;

export function saveChatScrollPosition(sessionKey: string, scrollTop?: number) {
  let top = scrollTop;
  if (top === undefined) {
    // 无显式值（生产路径）时从 DOM 读；node 测试环境无 DOM 时跳过保存
    if (typeof document === "undefined" || typeof document.querySelector !== "function") {
      return;
    }
    const container = document.querySelector(".chat-thread") as HTMLElement | null;
    if (container) {
      // 贴底会话不记位置：切回保持 chatUserNearBottom=true 走既有贴底链路（渐进
      // 注水 + stick-to-bottom）。记位置反而有害——restoreChatScrollPosition 会把
      // 贴底态置 false，还原值又常被注水/CV 占位估算 clamp 到历史中部，贴底跟流中断
      if (
        container.scrollHeight - container.scrollTop - container.clientHeight <
        NEAR_BOTTOM_THRESHOLD
      ) {
        sessionScrollPositions.delete(sessionKey);
        return;
      }
      top = container.scrollTop;
    } else {
      top = 0;
    }
  }
  sessionScrollPositions.delete(sessionKey); // 重新插入以刷新迭代序（LRU 语义）
  sessionScrollPositions.set(sessionKey, top);
  while (sessionScrollPositions.size > SESSION_SCROLL_POSITION_MAX) {
    const oldest = sessionScrollPositions.keys().next().value;
    if (oldest === undefined) break;
    sessionScrollPositions.delete(oldest);
  }
}

/** 一次性读取（还原后即删除） */
export function takeChatScrollPosition(sessionKey: string): number | null {
  const top = sessionScrollPositions.get(sessionKey) ?? null;
  sessionScrollPositions.delete(sessionKey);
  return top;
}

// 会话被删除时同步清理（deleteSessionFromSidebar 调用，对齐草稿/run 态快照清理）
export function clearSessionScrollPosition(sessionKey: string) {
  sessionScrollPositions.delete(sessionKey);
}

// 切回时还原：先置 chatUserNearBottom=false（仅非贴底会话有保存条目，贴底会话
// 不记位置），再在渲染完成后写回 scrollTop。代际守卫同 scheduleChatScroll——
// 切换后若有更新的滚动调度（历史加载触发），本次还原即过期。
export function restoreChatScrollPosition(
  host: {
    updateComplete?: Promise<unknown>;
    chatScrollGeneration: number;
    chatUserNearBottom: boolean;
  },
  sessionKey: string,
): void {
  const saved = takeChatScrollPosition(sessionKey);
  if (saved == null) {
    return;
  }
  host.chatUserNearBottom = false;
  if (typeof host.updateComplete?.then !== "function") {
    return; // 测试替身无渲染管线：位置记忆已消费即可
  }
  const generation = host.chatScrollGeneration;
  void host.updateComplete.then(() => {
    if (generation !== host.chatScrollGeneration) {
      return;
    }
    if (typeof document === "undefined" || typeof document.querySelector !== "function") {
      return;
    }
    const container = document.querySelector(".chat-thread") as HTMLElement | null;
    if (container) {
      container.scrollTop = saved;
    }
  });
}
