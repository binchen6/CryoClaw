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
  loadBoard,
  type BoardHost,
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

test("views/chat-panels.ts：board iframe 引用 BOARD_WIDGET_SANDBOX 常量（非内联字符串）", () => {
  // R2b 拆分：会话仪表盘面板迁至 views/chat-panels.ts
  const src = readFileSync(new URL("../../../../../src/ui/components/oc-board-panel.ts", import.meta.url), "utf8");
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

test("board snapshots reject foreign frame origins and preserve generated titles", () => {
  const result=normalizeBoardSnapshot({revision:1,widgets:[
    {name:"ok",title:"模型生成的面板",frameUrl:"/__openclaw__/board/test/index.html?bt=t"},
    ...["//evil.test/x","https://evil.test/x","/\\evil.test/x","javascript:alert(1)"].map((frameUrl,i)=>({name:`bad-${i}`,frameUrl})),
  ]},"s1","http://localhost:18789");
  assert.equal(result.widgets.length,1);assert.equal(result.widgets[0].title,"模型生成的面板");
});

test("board refresh preserves content on failure and ignores an old connection", async () => {
  let resolveOld:(value:unknown)=>void=()=>{};
  const oldClient={request:()=>new Promise(resolve=>{resolveOld=resolve;})};
  const host:BoardHost={client:oldClient as unknown as BoardHost["client"],connected:true,sessionKey:"s1",settings:{gatewayUrl:"ws://localhost:18789"},board:emptyBoardState("s1")};
  const old=loadBoard(host);
  host.client={request:async()=>({revision:9,widgets:[{name:"current",frameUrl:"/board/current"}]})} as unknown as BoardHost["client"];
  await loadBoard(host);resolveOld({revision:1,widgets:[]});await old;
  assert.equal(host.board.revision,9);
  host.client={request:async()=>{throw Error("offline");}} as unknown as BoardHost["client"];
  await loadBoard(host);assert.equal(host.board.revision,9);assert.equal(host.board.error,"refresh_failed");
  assert.equal(host.board.widgets[0].name,"current");
});

test("boardChangedNeedsReload：会话过滤 + revision 回声跳过", () => {
  const current = { ...emptyBoardState("agent:main:main"), revision: 3 };
  assert.equal(boardChangedNeedsReload({ sessionKey: "other", revision: 9 }, "agent:main:main", current), false);
  assert.equal(boardChangedNeedsReload({ sessionKey: "agent:main:main", revision: 3 }, "agent:main:main", current), false);
  assert.equal(boardChangedNeedsReload({ sessionKey: "agent:main:main", revision: 4 }, "agent:main:main", current), true);
  assert.equal(boardChangedNeedsReload(undefined, "agent:main:main", current), false);
});
