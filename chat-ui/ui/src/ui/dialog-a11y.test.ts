import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  closeTopDialog,
  findOpenDialog,
  focusOpenDialogIfNeeded,
  restoreDialogOpener,
  restoreDialogOpenerSoon,
  trapDialogTab,
} from "./dialog-a11y.ts";

test("modal Tab wraps in both directions and excludes disabled or hidden controls", () => {
  let focused: unknown;
  const control = (disabled = false, visible = true) => ({
    tabIndex: 0,
    matches: () => disabled,
    closest: () => null,
    getClientRects: () => visible ? [{}] : [],
    focus() { focused = this; },
  });
  const first = control();
  const last = control();
  const dialog = {
    getClientRects: () => [{}],
    querySelectorAll: () => [control(true), first, last, control(false, false)],
    focus() { focused = this; },
  };
  const doc = {
    querySelectorAll: () => [dialog],
    activeElement: last,
    defaultView: { getComputedStyle: () => ({ visibility: "visible" }) },
  };
  const event = (shiftKey = false) => ({ key: "Tab", shiftKey, preventDefault() {} }) as KeyboardEvent;
  assert.equal(trapDialogTab(event(), doc as unknown as Document), true);
  assert.equal(focused, first);
  doc.activeElement = first;
  assert.equal(trapDialogTab(event(true), doc as unknown as Document), true);
  assert.equal(focused, last);
  assert.equal(trapDialogTab(event(), doc as unknown as Document), false);
  doc.activeElement = control();
  assert.equal(trapDialogTab(event(), doc as unknown as Document), true);
  assert.equal(focused, first);
});

test("modal without controls retains focus; non-modal Tab is unchanged", () => {
  let focused = false;
  const dialog = {
    getClientRects: () => [{}], querySelectorAll: () => [],
    focus() { focused = true; },
  };
  const event = { key: "Tab", preventDefault() {} } as KeyboardEvent;
  assert.equal(trapDialogTab(event, {
    querySelectorAll: () => [dialog],
  } as unknown as Document), true);
  assert.equal(focused, true);
  assert.equal(trapDialogTab(event, {
    querySelectorAll: () => [],
  } as unknown as Document), false);
});

test("findOpenDialog 跳过没有布局盒子的弹窗（display:none / 已卸载）", () => {
  const hidden = { getClientRects: () => [] };
  const shown = { getClientRects: () => [{}] };
  assert.equal(findOpenDialog({
    querySelectorAll: () => [shown, hidden],
  } as unknown as Document), shown);
  assert.equal(findOpenDialog({
    querySelectorAll: () => [hidden],
  } as unknown as Document), null);
});

// ── 原路返回（P1-8）：关闭后焦点还给打开弹窗的那个控件 ──────────────────────
// 没有 jsdom，也没有 window：用最小 stub 驱动纯逻辑（谁被 focus、状态清没清、
// 失败路径抛不抛错、退场期间会不会抢焦点）。

type StubEl = {
  name: string;
  doc: StubDoc;
  isConnected: boolean;
  focus(options?: unknown): void;
  getClientRects(): unknown[];
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  closest(selector?: string): unknown;
  contains(node: unknown): boolean;
  querySelector(selector: string): StubEl | null;
  click(): void;
};

type StubDoc = {
  activeElement: unknown;
  body: unknown;
  documentElement: unknown;
  dialogs: StubEl[];
  extras: StubEl[];
  frames: Array<() => void>;
  querySelectorAll(selector: string): StubEl[];
  querySelector(selector: string): StubEl | null;
  defaultView: {
    requestAnimationFrame(cb: () => void): number;
    getComputedStyle(): { visibility: string; display: string };
  };
};

let focused: { name: string; options?: unknown } | null = null;

// 通过函数读取，避免 TS 对模块级 let 做控制流收窄（`focused = null` 之后会被当成永远 null）。
function focusedNow(): { name: string; options?: unknown } | null {
  return focused;
}

function createDoc(): StubDoc {
  const doc: StubDoc = {
    activeElement: null,
    body: { nodeName: "BODY" },
    documentElement: { nodeName: "HTML" },
    dialogs: [],
    extras: [],
    frames: [],
    querySelectorAll(selector: string) {
      return selector.includes("data-dialog-return-focus") ? doc.extras : doc.dialogs;
    },
    querySelector: () => null,
    defaultView: {
      requestAnimationFrame(cb: () => void) {
        doc.frames.push(cb);
        return doc.frames.length;
      },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    },
  };
  return doc;
}

function el(doc: StubDoc, name: string, over: Partial<StubEl> = {}): StubEl {
  const node = {
    name,
    doc,
    isConnected: true,
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    closest: () => null,
    contains: () => false,
    querySelector: () => null,
    click() {},
    focus(options?: unknown) {
      focused = { name, options };
      doc.activeElement = node;
    },
    ...over,
  } as StubEl;
  return node;
}

// closeTopDialog 里 240ms 的兜底定时器不该在测试进程里真跑：换成可手动推进的队列。
function withFakeTimers(run: (timers: Array<() => void>) => void): void {
  const timers: Array<() => void> = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = (cb: () => void) => {
    timers.push(cb);
    return timers.length;
  };
  (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = () => {};
  try {
    run(timers);
  } finally {
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
    (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = realClearTimeout;
  }
}

test("opener restore：焦点移入弹窗时记录 opener，关闭后回到它并清掉记录", () => {
  focused = null;
  const doc = createDoc();
  const opener = el(doc, "opener");
  const dialog = el(doc, "dialog");
  doc.dialogs = [dialog];
  doc.activeElement = opener;

  assert.equal(focusOpenDialogIfNeeded(doc as unknown as Document), true);
  assert.equal(focusedNow()?.name, "dialog", "焦点先移入弹窗");

  // 关闭：弹窗被移除，焦点落回 body
  doc.dialogs = [];
  doc.activeElement = doc.body;
  assert.equal(restoreDialogOpener(dialog as unknown as HTMLElement, doc as unknown as Document), true);
  assert.equal(focusedNow()?.name, "opener");
  assert.equal(doc.activeElement, opener);
  assert.equal((focusedNow()?.options as { preventScroll?: boolean } | undefined)?.preventScroll, true,
    "回焦不应滚动页面（preventScroll）");

  // 一次性：状态已清，同一个节点再问返回 false
  focused = null;
  assert.equal(restoreDialogOpener(dialog as unknown as HTMLElement, doc as unknown as Document), false);
  assert.equal(focused, null);
});

test("opener restore：opener 被重渲染删掉时静默放弃，不抛错", () => {
  focused = null;
  const doc = createDoc();
  const opener = el(doc, "opener");
  const dialog = el(doc, "dialog");
  doc.dialogs = [dialog];
  doc.activeElement = opener;
  focusOpenDialogIfNeeded(doc as unknown as Document);
  focused = null; // 丢掉 setup 阶段"焦点移入弹窗"的记录，只观察 restore 有没有再动焦点

  opener.isConnected = false;
  opener.getClientRects = () => [];
  doc.dialogs = [];
  doc.activeElement = doc.body;
  assert.doesNotThrow(() => restoreDialogOpener(dialog as unknown as HTMLElement, doc as unknown as Document));
  assert.equal(restoreDialogOpener(dialog as unknown as HTMLElement, doc as unknown as Document), false);
  assert.equal(focused, null, "opener 没了就不该把焦点按到看不见的地方");
  // null / 没记录过的弹窗同样不抛错
  assert.equal(restoreDialogOpener(null, doc as unknown as Document), false);
  assert.equal(restoreDialogOpener(el(doc, "other") as unknown as HTMLElement, doc as unknown as Document), false);
});

test("opener restore：opener 没了就退到几何上最近的 [data-dialog-return-focus]", () => {
  focused = null;
  const doc = createDoc();
  const opener = el(doc, "opener", {
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 20, height: 20 }),
  });
  const dialog = el(doc, "dialog");
  doc.dialogs = [dialog];
  doc.activeElement = opener;
  focusOpenDialogIfNeeded(doc as unknown as Document);

  const far = el(doc, "far-target", {
    getBoundingClientRect: () => ({ left: 900, top: 900, width: 10, height: 10 }),
  });
  const near = el(doc, "near-target", {
    getBoundingClientRect: () => ({ left: 104, top: 104, width: 12, height: 12 }),
  });
  opener.isConnected = false;
  opener.getClientRects = () => [];
  doc.extras = [far, near];
  doc.dialogs = [];
  doc.activeElement = doc.body;

  assert.equal(restoreDialogOpener(dialog as unknown as HTMLElement, doc as unknown as Document), true);
  assert.equal(focusedNow()?.name, "near-target");
});

test("opener restore：应把自己把焦点落到别处时不抢", () => {
  focused = null;
  const doc = createDoc();
  const opener = el(doc, "opener");
  const dialog = el(doc, "dialog");
  doc.dialogs = [dialog];
  doc.activeElement = opener;
  focusOpenDialogIfNeeded(doc as unknown as Document);
  focused = null; // 同样先清 setup 的记录

  // 关闭后应用主动把焦点还给了输入框
  const textarea = el(doc, "textarea");
  doc.activeElement = textarea;
  doc.dialogs = [];
  assert.equal(restoreDialogOpener(dialog as unknown as HTMLElement, doc as unknown as Document), false);
  assert.equal(focused, null, "应用已经安排好落点时不该被回焦覆盖");
});

test("closeTopDialog：点 [data-dialog-dismiss]，退场期间不回焦，卸完 DOM 才回焦", () => {
  focused = null;
  const doc = createDoc();
  const opener = el(doc, "opener");
  let clicks = 0;
  const dismiss = el(doc, "dismiss", {
    click() {
      clicks++;
      // 真实路径：dismiss.click() 触发 runExitAnimation，200ms 后才 finalize 移除 DOM。
      // 这里让弹窗在 dom detach 前保持"打开"状态。
    },
  });
  const dialog = el(doc, "dialog", { querySelector: (selector: string) => selector === "[data-dialog-dismiss]" ? dismiss : null });
  doc.dialogs = [dialog];
  doc.activeElement = opener;
  focusOpenDialogIfNeeded(doc as unknown as Document);
  assert.equal(focusedNow()?.name, "dialog");

  withFakeTimers((timers) => {
    assert.equal(closeTopDialog(doc as unknown as Document), true);
    assert.equal(clicks, 1, "Escape 语义：点显式 dismiss 按钮");
    assert.equal(doc.frames.length, 1, "关闭后下一帧尝试回焦");
    assert.equal(timers.length, 1, "同时挂一个 240ms 兜底（退场动画结束时点）");

    // 第一帧：弹窗还在台上播退场帧 → 让位
    focused = null;
    doc.frames.shift()!();
    assert.equal(focused, null, "弹窗还开着就不该抢焦点");

    // 第二帧：DOM 还没卸 → 继续等
    doc.frames.shift()!();
    assert.equal(focused, null);

    // 兜底时刻：弹窗已卸载 → 回焦 opener
    doc.dialogs = [];
    doc.activeElement = doc.body;
    timers.shift()!();
    assert.equal(focusedNow()?.name, "opener");
  });
});

test("closeTopDialog：退出期间又开了别的弹窗，焦点归新弹窗（不抢）", () => {
  focused = null;
  const doc = createDoc();
  const opener = el(doc, "opener");
  const first = el(doc, "first-dialog");
  const second = el(doc, "second-dialog");
  doc.dialogs = [first];
  doc.activeElement = opener;
  focusOpenDialogIfNeeded(doc as unknown as Document);

  withFakeTimers((timers) => {
    assert.equal(closeTopDialog(doc as unknown as Document), true);
    // 关闭动作派发后立刻开了第二个弹窗
    doc.dialogs = [second];
    doc.activeElement = doc.body;
    focused = null;
    doc.frames.shift()!();
    assert.equal(focused, null, "第二个弹窗还开着，第一帧不该回焦");
    timers.shift()!();
    assert.equal(focused, null, "兜底时刻仍只看到第二个弹窗，依然不回焦");
  });
});

test("closeTopDialog：退场比预期慢时，第二个检查点（400ms）仍会回焦", () => {
  focused = null;
  const doc = createDoc();
  const opener = el(doc, "opener");
  const dialog = el(doc, "dialog");
  doc.dialogs = [dialog];
  doc.activeElement = opener;
  focusOpenDialogIfNeeded(doc as unknown as Document);

  withFakeTimers((timers) => {
    assert.equal(closeTopDialog(doc as unknown as Document), true);
    // 两个 rAF 都在退场中
    doc.frames.shift()!();
    doc.frames.shift()!();
    assert.equal(timers.length, 1, "第一检查点已排队");
    focused = null;
    timers.shift()!(); // 240ms：弹窗还在台上
    assert.equal(focusedNow(), null);
    assert.equal(timers.length, 1, "未结算就续排第二个检查点");
    doc.dialogs = [];
    doc.activeElement = doc.body;
    timers.shift()!(); // 400ms：DOM 已卸
    assert.equal(focusedNow()?.name, "opener");
  });
});

test("restoreDialogOpenerSoon：给自写关闭路径的弹窗用，无 opener 记录时不抛错", () => {
  const doc = createDoc();
  // 没记录过 opener：不该抛错，也不该动焦点
  focused = null;
  assert.doesNotThrow(() => restoreDialogOpenerSoon(el(doc, "dialog") as unknown as HTMLElement, doc as unknown as Document));
  assert.doesNotThrow(() => restoreDialogOpenerSoon(null, doc as unknown as Document));
  assert.equal(focused, null);
  // 有记录：和 closeTopDialog 同一条时序
  const opener = el(doc, "opener");
  const dialog = el(doc, "dialog");
  doc.dialogs = [dialog];
  doc.activeElement = opener;
  focusOpenDialogIfNeeded(doc as unknown as Document);
  withFakeTimers((timers) => {
    restoreDialogOpenerSoon(dialog as unknown as HTMLElement, doc as unknown as Document);
    doc.dialogs = []; // 退场后卸载
    doc.activeElement = doc.body;
    focused = null;
    while (timers.length) timers.shift()!();
    assert.equal(focusedNow()?.name, "opener");
  });
});

test("closeTopDialog：无弹窗时返回 false", () => {
  const doc = createDoc();
  assert.equal(closeTopDialog(doc as unknown as Document), false);
});

// ── 静态契约（渲染细节没有 jsdom，用源码断言锁住性质）─────────────────────

const read = (rel: string) => readFileSync(new URL(`../../../../src/${rel}`, import.meta.url), "utf8");

test("频道分组弹窗带 dialog 语义 + dismiss 标记，全局 Esc/Tab trap 才接管", () => {
  const src = read("ui/views/settings/tab-channels-shared.ts").replace(/\s+/g, " ");
  assert.ok(
    src.includes('class="oc-modal-overlay" role="dialog" aria-modal="true" tabindex="-1"'),
    'overlay 必须带 role="dialog" aria-modal="true" tabindex="-1"：DIALOG_SELECTOR 只认这个组合，'
    + "否则焦点在取消/确认按钮上时 Esc 无效、也没有 Tab trap",
  );
  assert.ok(src.includes("data-dialog-dismiss"), "取消按钮必须带 data-dialog-dismiss，closeTopDialog 才能点它关闭");
  assert.ok(src.includes("data-dialog-autofocus"), "打开时被聚焦的输入框需要 data-dialog-autofocus 锚点");
});

test("rail 错误悬浮卡在 drag 区内显式 opt-out，否则真实鼠标点不到", () => {
  const block = read("styles/shell.css").match(/\.oc-rail__error-popup \{([^}]*)\}/);
  assert.ok(block, ".oc-rail__error-popup 规则存在");
  assert.match(block[1], /-webkit-app-region: no-drag/);
});
