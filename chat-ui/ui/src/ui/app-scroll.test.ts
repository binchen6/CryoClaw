// scheduleChatScroll 代际守卫：updateComplete.then 闭包不可取消，同帧两次调度
// 会产生双重滚动且 rAF 句柄互踩（旧闭包覆盖新句柄，新调度反而取消不掉旧帧）。
// 单调递增代际号：rAF/timeout 回调落地前比对代际，过期即返回。
import test from "node:test";
import assert from "node:assert/strict";
import { scheduleChatScroll, resetChatScroll } from "./app-scroll.ts";

type RafFn = FrameRequestCallback;

class FakeRaf {
  callbacks = new Map<number, RafFn>();
  private nextId = 1;

  requestAnimationFrame(fn: RafFn) {
    const id = this.nextId++;
    this.callbacks.set(id, fn);
    return id;
  }

  cancelAnimationFrame(id: number) {
    this.callbacks.delete(id);
  }

  runAll() {
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const fn of pending) fn(0);
  }
}

const scrollCalls: Array<{ top: number }> = [];

function installGlobals(raf: FakeRaf) {
  const target = {
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 0,
    scrollTo(opts: { top: number }) {
      this.scrollTop = opts.top;
      scrollCalls.push({ top: opts.top });
    },
  };
  Object.assign(globalThis, {
    requestAnimationFrame: (fn: RafFn) => raf.requestAnimationFrame(fn),
    cancelAnimationFrame: (id: number) => raf.cancelAnimationFrame(id),
    document: { scrollingElement: target, documentElement: target },
    getComputedStyle: () => ({ overflowY: "visible" }),
    window: {
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  });
  return target;
}

function makeHost(updateComplete: Promise<unknown>) {
  return {
    updateComplete,
    querySelector: () => null,
    style: {} as CSSStyleDeclaration,
    chatScrollFrame: null as number | null,
    chatScrollTimeout: null as number | null,
    chatScrollGeneration: 0,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatNewMessagesBelow: false,
  };
}

test("同帧两次调度：旧 updateComplete 后至的闭包不得覆盖新句柄造成双重滚动", async () => {
  const raf = new FakeRaf();
  installGlobals(raf);
  scrollCalls.length = 0;

  // 第一次调度读到「慢」updateComplete，第二次读到「快」的——旧代码里慢闭包
  // 后至会覆盖 chatScrollFrame 句柄且不取消旧帧，两帧都落地 → 双重滚动。
  let resolveSlow!: () => void;
  const slow = new Promise<void>((r) => (resolveSlow = r));
  const host = makeHost(slow);
  scheduleChatScroll(host);
  host.updateComplete = Promise.resolve();
  scheduleChatScroll(host);

  await Promise.resolve(); // 快 then 先落地：调度 rAF（代际 2）
  resolveSlow();
  await Promise.resolve(); // 慢 then 后至：代际 1 ≠ 当前代际 → 必须直接返回
  raf.runAll();

  assert.equal(scrollCalls.length, 1, "过期闭包不得再产生滚动（双重滚动回归）");
  assert.equal(host.chatScrollFrame, null);
});

test("resetChatScroll 使在途调度全部过期（会话切换后旧滚动不得回写）", async () => {
  const raf = new FakeRaf();
  installGlobals(raf);
  scrollCalls.length = 0;

  const host = makeHost(Promise.resolve());
  scheduleChatScroll(host);
  resetChatScroll(host); // 代际自增：then/rAF 落地前比对即过期
  await Promise.resolve();
  raf.runAll();

  assert.equal(scrollCalls.length, 0, "reset 后在途调度闭包不得再回写滚动位置");
});

test("正常单调度：then → rAF 各落地一次，滚动一次", async () => {
  const raf = new FakeRaf();
  installGlobals(raf);
  scrollCalls.length = 0;

  const host = makeHost(Promise.resolve());
  scheduleChatScroll(host);
  await Promise.resolve();
  assert.equal(raf.callbacks.size, 1, "updateComplete 后应调度一帧 rAF");
  raf.runAll();

  assert.equal(scrollCalls.length, 1);
  assert.equal(host.chatScrollFrame, null, "rAF 落地后句柄应复位");
});

// ── 切换会话不断流配套：滚动位置按会话记忆 ──

import {
  clearSessionScrollPosition,
  restoreChatScrollPosition,
  saveChatScrollPosition,
  takeChatScrollPosition,
} from "./app-scroll.ts";

test("save/take 滚动位置：一次性读取，未命中为 null", () => {
  saveChatScrollPosition("scroll-a", 480);
  assert.equal(takeChatScrollPosition("scroll-a"), 480);
  assert.equal(takeChatScrollPosition("scroll-a"), null, "take 为一次性语义");
  assert.equal(takeChatScrollPosition("never-saved"), null);
});

test("clearSessionScrollPosition：删除会话时清理，防同名 key 复用", () => {
  saveChatScrollPosition("scroll-clear", 100);
  clearSessionScrollPosition("scroll-clear");
  assert.equal(takeChatScrollPosition("scroll-clear"), null);
});

test("LRU 上限 20：最旧滚动位置被逐出", () => {
  for (let i = 1; i <= 21; i++) {
    saveChatScrollPosition(`scroll-lru-${i}`, i);
  }
  assert.equal(takeChatScrollPosition("scroll-lru-1"), null, "超限后最旧被逐出");
  assert.equal(takeChatScrollPosition("scroll-lru-21"), 21);
});

test("restoreChatScrollPosition：还原 scrollTop、置 chatUserNearBottom=false，代际过期即跳过", async () => {
  const container = { scrollTop: 0 };
  const prevDocument = (globalThis as Record<string, unknown>).document;
  Object.assign(globalThis, {
    document: {
      querySelector: (selector: string) => (selector === ".chat-thread" ? container : null),
    },
  });
  try {
    const host = {
      updateComplete: Promise.resolve(),
      chatScrollGeneration: 0,
      chatUserNearBottom: true,
    };
    saveChatScrollPosition("scroll-restore", 720);
    restoreChatScrollPosition(host, "scroll-restore");
    assert.equal(host.chatUserNearBottom, false, "还原后不得强拉回底");
    await Promise.resolve();
    assert.equal(container.scrollTop, 720, "scrollTop 应写回记忆位置");
    assert.equal(takeChatScrollPosition("scroll-restore"), null, "位置记忆一次性消费");

    // 代际过期：resetChatScroll（代际自增）后还原闭包不得回写
    const container2 = { scrollTop: 0 };
    const doc2 = {
      querySelector: (selector: string) => (selector === ".chat-thread" ? container2 : null),
    };
    Object.assign(globalThis, { document: doc2 });
    const host2 = {
      updateComplete: Promise.resolve(),
      chatScrollGeneration: 5,
      chatUserNearBottom: true,
    };
    saveChatScrollPosition("scroll-stale", 300);
    restoreChatScrollPosition(host2, "scroll-stale");
    host2.chatScrollGeneration += 1; // 模拟其后又有更新的滚动调度
    await Promise.resolve();
    assert.equal(container2.scrollTop, 0, "代际过期后不得回写滚动位置");
  } finally {
    (globalThis as Record<string, unknown>).document = prevDocument;
  }
});
