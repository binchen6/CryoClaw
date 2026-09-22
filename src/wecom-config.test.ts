// wecom-config WebSocket 帧状态机回归（F1 修复）。
// 旧 parseWsTextFrame 只看 payload 长度凑齐与否，忽略 opcode/FIN：服务端分片
// （FIN=0 text + continuation）或响应前夹带 ping 时，会把控制帧/分片首帧当完整
// JSON 解析 → JSON.parse 抛错 → 凭据合法也报「验证失败」。本文件覆盖状态机的
// 分片拼合、控制帧处理、多帧同 chunk 与协议错误形态。
// electron 依赖 mock（对齐 skill-store.test.ts）：wecom-config → constants 链在
// import 时会加载 electron。
import { test, expect, vi } from "vitest";
import { createWsFrameParser } from "./wecom-config";
import type { WsFrameEvent } from "./wecom-config";

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getVersion: () => "0.0.0",
    getAppPath: () => "/app",
  },
  ipcMain: { handle: vi.fn() },
}));

type FrameOptions = {
  // 强制使用扩展长度编码（覆盖 126/127 分支，即使 payload 很小）
  extLen?: 126 | 127;
};

// 构造服务端帧（无 mask）。FIN + opcode + 长度编码与 RFC 6455 一致。
function buildServerFrame(fin: boolean, opcode: number, payload: string | Buffer, opts?: FrameOptions): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  let header: Buffer;
  if (opts?.extLen === 126) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else if (opts?.extLen === 127) {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  } else if (data.length < 126) {
    header = Buffer.alloc(2);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function texts(events: WsFrameEvent[]): string[] {
  return events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text);
}

test("单 text 帧：一次 push 即得到完整文本", () => {
  const parser = createWsFrameParser();
  const events = parser.push(buildServerFrame(true, 0x1, '{"errcode":0}'));
  expect(texts(events)).toEqual(['{"errcode":0}']);
});

test("FIN=0 text + continuation：分片跨 chunk 拼合后返回完整文本", () => {
  const parser = createWsFrameParser();
  const whole = '{"errcode":0,"msg":"ok"}';
  const cut = 10;
  const first = buildServerFrame(false, 0x1, whole.slice(0, cut));
  const second = buildServerFrame(true, 0x0, whole.slice(cut));

  // 首分片到达：尚无完整消息
  expect(parser.push(first)).toEqual([]);
  // 分片中间字节按半截帧处理：先给 1 字节头试探，也不能产出消息或报错
  expect(parser.push(second.subarray(0, 1))).toEqual([]);
  expect(texts(parser.push(second.subarray(1)))).toEqual([whole]);
});

test("ping 帧：产出 ping 事件（调用方回 pong），后续 text 正常解析", () => {
  const parser = createWsFrameParser();
  const ping = parser.push(buildServerFrame(true, 0x9, "abc"));
  expect(ping).toEqual([{ kind: "ping", payload: Buffer.from("abc") }]);

  const text = parser.push(buildServerFrame(true, 0x1, '{"errcode":0}'));
  expect(texts(text)).toEqual(['{"errcode":0}']);
});

test("pong 帧：跳过且不产出事件", () => {
  const parser = createWsFrameParser();
  expect(parser.push(buildServerFrame(true, 0xa, ""))).toEqual([]);
  expect(texts(parser.push(buildServerFrame(true, 0x1, "next")))).toEqual(["next"]);
});

test("同一 chunk 含 ping + text 两帧：逐帧消费，text 完整返回", () => {
  const parser = createWsFrameParser();
  const chunk = Buffer.concat([
    buildServerFrame(true, 0x9, "ping-payload"),
    buildServerFrame(true, 0x1, '{"errcode":0}'),
  ]);
  const events = parser.push(chunk);
  expect(events[0]).toEqual({ kind: "ping", payload: Buffer.from("ping-payload") });
  expect(texts(events)).toEqual(['{"errcode":0}']);
});

test("同一 chunk 含两个 text 帧： sequential 产出两条消息", () => {
  const parser = createWsFrameParser();
  const chunk = Buffer.concat([
    buildServerFrame(true, 0x1, '{"seq":1}'),
    buildServerFrame(true, 0x1, '{"seq":2}'),
  ]);
  expect(texts(parser.push(chunk))).toEqual(['{"seq":1}', '{"seq":2}']);
});

test("126 扩展长度：单帧正常解析", () => {
  const parser = createWsFrameParser();
  const payload = "x".repeat(300);
  const events = parser.push(buildServerFrame(true, 0x1, payload));
  expect(texts(events)).toEqual([payload]);
});

test("127 扩展长度：强制 64 位长度编码也能解析", () => {
  const parser = createWsFrameParser();
  const payload = "y".repeat(100);
  const events = parser.push(buildServerFrame(true, 0x1, payload, { extLen: 127 }));
  expect(texts(events)).toEqual([payload]);
});

test("非法 opcode（0x3）：返回 error 事件而非静默吞掉", () => {
  const parser = createWsFrameParser();
  const events = parser.push(buildServerFrame(true, 0x3, "junk"));
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("error");
});

test("非法 opcode（0xB）：返回 error 事件", () => {
  const parser = createWsFrameParser();
  const events = parser.push(buildServerFrame(true, 0xb, "junk"));
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("error");
});

test("超长控制帧（ping 用 126 扩展长度）：返回 error 事件", () => {
  const parser = createWsFrameParser();
  const events = parser.push(buildServerFrame(true, 0x9, "p".repeat(130)));
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("error");
});

test("无起始帧的 continuation：返回 error 事件", () => {
  const parser = createWsFrameParser();
  const events = parser.push(buildServerFrame(true, 0x0, "orphan"));
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("error");
});

test("close 帧：产出 closed 事件并终止解析", () => {
  const parser = createWsFrameParser();
  const chunk = Buffer.concat([
    buildServerFrame(true, 0x8, "bye"),
    buildServerFrame(true, 0x1, '{"errcode":0}'),
  ]);
  const events = parser.push(chunk);
  expect(events).toEqual([{ kind: "closed", reason: "bye" }]);
});
