// R89 Board（会话仪表盘）controller 测试：归一化 / changed 过滤 / frameOrigin。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BOARD_WIDGET_SANDBOX,
  boardChangedNeedsReload,
  boardFrameOrigin,
  emptyBoardState,
  normalizeBoardSnapshot,
} from "./board.ts";

// F9：widget iframe 的 sandbox 组合安全钉点。allow-scripts + allow-same-origin 是
// 已知失效组合（iframe 内脚本拥有 gateway 源完整能力），board 内容来自 agent 生成
// 属不可信输入，必须保持 opaque origin（内核侧 widget 文档自带 CSP sandbox
// allow-scripts，不依赖同源 cookie/storage，与父窗口无 postMessage 通信）。
test("BOARD_WIDGET_SANDBOX：不含 allow-same-origin（防沙箱失效组合）", () => {
  assert.equal(BOARD_WIDGET_SANDBOX.includes("allow-same-origin"), false);
  assert.equal(BOARD_WIDGET_SANDBOX.includes("allow-scripts"), true);
  assert.equal(BOARD_WIDGET_SANDBOX.includes("allow-forms"), true);
});

test("views/chat.ts：board iframe 引用 BOARD_WIDGET_SANDBOX 常量（非内联字符串）", () => {
  const src = readFileSync(new URL("../../../../../src/ui/views/chat.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /sandbox=\$\{BOARD_WIDGET_SANDBOX\}/,
    "board iframe 的 sandbox 属性应绑定 controllers/board.ts 的常量（单一事实来源）",
  );
  assert.equal(
    src.includes('sandbox="allow-scripts allow-same-origin allow-forms"'),
    false,
    "视图层不得再内联含 allow-same-origin 的 sandbox 字符串",
  );
});

test("boardFrameOrigin：ws/wss → http/https，非法输入返回 null", () => {
  assert.equal(boardFrameOrigin("ws://127.0.0.1:18789"), "http://127.0.0.1:18789");
  assert.equal(boardFrameOrigin("wss://gw.example.com"), "https://gw.example.com");
  assert.equal(boardFrameOrigin("http://127.0.0.1:18789"), null);
  assert.equal(boardFrameOrigin("not a url"), null);
});

test("normalizeBoardSnapshot：完整快照映射出 iframe src", () => {
  const { revision, widgets } = normalizeBoardSnapshot(
    {
      sessionKey: "agent:main:main",
      revision: 7,
      widgets: [
        {
          name: "system",
          revision: 2,
          contentKind: "html",
          kindLabel: "System",
          frameUrl: "/__openclaw__/board/agent%3Amain%3Amain/system/index.html?bt=ticket-1",
        },
        { name: "broken" },
        "junk",
      ],
    },
    "agent:main:main",
    "http://127.0.0.1:18789",
  );
  assert.equal(revision, 7);
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]!.name, "system");
  assert.equal(widgets[0]!.kindLabel, "System");
  assert.equal(
    widgets[0]!.src,
    "http://127.0.0.1:18789/__openclaw__/board/agent%3Amain%3Amain/system/index.html?bt=ticket-1",
  );
});

test("normalizeBoardSnapshot：空 board / 无 origin 归一为无 widget", () => {
  assert.deepEqual(normalizeBoardSnapshot(null, "k", "http://x"), { revision: null, widgets: [] });
  const noOrigin = normalizeBoardSnapshot({ revision: 1, widgets: [{ name: "w", frameUrl: "/x" }] }, "k", null);
  assert.equal(noOrigin.widgets.length, 0);
});

test("boardChangedNeedsReload：会话过滤 + revision 回声跳过", () => {
  const current = { ...emptyBoardState("agent:main:main"), revision: 3 };
  assert.equal(boardChangedNeedsReload({ sessionKey: "other", revision: 9 }, "agent:main:main", current), false);
  assert.equal(boardChangedNeedsReload({ sessionKey: "agent:main:main", revision: 3 }, "agent:main:main", current), false);
  assert.equal(boardChangedNeedsReload({ sessionKey: "agent:main:main", revision: 4 }, "agent:main:main", current), true);
  assert.equal(boardChangedNeedsReload(undefined, "agent:main:main", current), false);
});
