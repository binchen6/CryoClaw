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
