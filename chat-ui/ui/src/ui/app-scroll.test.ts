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
