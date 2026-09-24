import assert from "node:assert/strict";
import { GatewayBrowserClient } from "./gateway.ts";
import { FakeScheduler } from "../test-utils/fake-scheduler.ts";

// 最小可控定时器，手动推进回调。
class FakeTimers extends FakeScheduler<() => void> {
  constructor() {
    super((fn) => fn());
  }

  setTimeout(fn: () => void): number {
    return this.schedule(fn);
  }

  clearTimeout(id: number) {
    this.cancel(id);
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: any) => void) {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(handler);
    this.listeners.set(type, bucket);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  // 手动触发 open，模拟底层 socket 已建立但握手尚未完成。
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  message(data: unknown) {
    this.emit("message", { data });
  }

  private emit(type: string, event: any) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
}

function createStorage() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
}

function installBrowserGlobals(timers: FakeTimers) {
  const storage = createStorage();
  const windowLike = {
    setTimeout: (fn: () => void, _delay?: number) => timers.setTimeout(fn),
    clearTimeout: (id: number) => timers.clearTimeout(id),
    localStorage: storage,
  };

  Object.assign(globalThis, {
    window: windowLike,
    localStorage: storage,
    WebSocket: FakeWebSocket,
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
      getRandomValues<T extends Uint8Array>(array: T) {
        return array;
      },
    },
  });

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      platform: "test",
      userAgent: "test-agent",
      language: "en-US",
    },
  });
}

async function flushMicrotasks() {
  await Promise.resolve();
}

// 完成 connect 握手：应答 hello-ok，让 client 进入已连接状态。
function completeHello(socket: FakeWebSocket) {
  const connectRequest = socket.sent.find((payload) => JSON.parse(payload).method === "connect");
  socket.message(
    JSON.stringify({
      type: "res",
      id: JSON.parse(connectRequest!).id,
      ok: true,
      payload: { type: "hello-ok", protocol: 3 },
    }),
  );
}

async function testReconnectNowCancelsScheduledReconnect() {
  FakeWebSocket.instances = [];
  const timers = new FakeTimers();
  installBrowserGlobals(timers);

  const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:18789" });
  client.start();
  assert.equal(FakeWebSocket.instances.length, 1, "首次启动应只创建一条 socket");

  FakeWebSocket.instances[0].close(1006, "boom");
  client.reconnectNow();
  assert.equal(FakeWebSocket.instances.length, 2, "立即重连应只额外创建一条 socket");

  timers.runAll();
  assert.equal(
    FakeWebSocket.instances.length,
    2,
    "旧的退避重连 timer 不应再偷偷创建第三条 socket",
  );
}

async function testRequestMustWaitForHelloHandshake() {
  FakeWebSocket.instances = [];
  const timers = new FakeTimers();
  installBrowserGlobals(timers);

  const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:18789" });
  client.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();

  const requestResult = client.request("node.list").then(
    () => "resolved",
    (error) => `rejected:${error instanceof Error ? error.message : String(error)}`,
  );
  await flushMicrotasks();
  const outcome = await Promise.race([requestResult, Promise.resolve("pending")]);

  assert.notEqual(outcome, "pending", "未完成 hello 握手时，请求不应悬空挂起");
  assert.match(String(outcome), /^rejected:/, "未完成 hello 握手时，请求应立即被拒绝");
  assert.equal(socket.sent.length, 0, "未完成 hello 握手前，不应向 gateway 发送业务请求");

}

// 已完成 hello 后，业务请求必须有超时兜底，不能无限悬空。
async function testRequestTimesOutWhenGatewayNeverResponds() {
  FakeWebSocket.instances = [];
  const timers = new FakeTimers();
  installBrowserGlobals(timers);

  const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:18789" });
  client.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();

  timers.runNext();
  await flushMicrotasks();
  const connectRequest = socket.sent.find((payload) => JSON.parse(payload).method === "connect");
  assert.ok(connectRequest, "握手阶段应先发出 connect 请求");
  const connectId = JSON.parse(connectRequest).id;
  socket.message(
    JSON.stringify({
      type: "res",
      id: connectId,
      ok: true,
      payload: { type: "hello-ok", protocol: 3 },
    }),
  );
  await flushMicrotasks();

  const requestResult = client.request("chat.history").then(
    () => "resolved",
    (error) => `rejected:${error instanceof Error ? error.message : String(error)}`,
  );

  timers.runAll();
  await flushMicrotasks();
  const outcome = await Promise.race([requestResult, Promise.resolve("pending")]);

  assert.notEqual(outcome, "pending", "gateway 长时间不响应时，请求不应无限悬空");
  assert.match(String(outcome), /^rejected:/, "gateway 超时后，请求应明确 reject");
}

async function testInvalidUrlDoesNotThrowAndGoesToReconnectPath() {
  FakeWebSocket.instances = [];
  const timers = new FakeTimers();
  installBrowserGlobals(timers);

  // F8：URL 非法（localStorage 脏数据 / URL 参数注入）时 WebSocket 构造器同步抛
  // SyntaxError——client.start() 不得向外抛，应走 onClose 错误通道 + 退避重连。
  class ThrowingWebSocket {
    constructor(_url: string) {
      throw new SyntaxError("The URL 'javascript:alert(1)' is invalid.");
    }
  }
  (globalThis as Record<string, unknown>).WebSocket = ThrowingWebSocket;

  const closes: Array<{ code: number; reason: string }> = [];
  const client = new GatewayBrowserClient({
    url: "javascript:alert(1)",
    onClose: (info) => closes.push(info),
  });
  let threw = false;
  try {
    client.start();
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "非法 URL 时 start() 不得同步抛异常");
  assert.equal(closes.length, 1, "应经 onClose 错误通道上报一次");
  assert.equal(closes[0]!.code, 4008, "合成关闭应使用既有 connect-failed 错误码");
  assert.match(closes[0]!.reason, /invalid gateway url/, "关闭原因应标明 URL 非法");
  assert.equal(
    (timers as unknown as { tasks: Map<number, unknown> }).tasks.size,
    1,
    "应排一个退避重连 timer（沿用既有重连机制）",
  );

  // 重连 timer 触发后再试一次：依旧不抛、错误通道再次上报、再次排重连。
  timers.runNext();
  assert.equal(closes.length, 2, "退避重连再次命中非法 URL 应再次上报");
  client.stop();
  // 恢复默认 FakeWebSocket，避免污染同文件后续用例
  installBrowserGlobals(timers);
}

// R2 流式输出对话重复修复：重复/回绕 seq 帧（服务端重发、重连重放）必须整帧
// 丢弃——投递出去会让流式 delta 被重复处理，同一段正文双份上屏；且不得误报 onGap。
async function testDuplicateOrRewindSeqFramesAreDroppedWithoutGap() {
  FakeWebSocket.instances = [];
  const timers = new FakeTimers();
  installBrowserGlobals(timers);

  const events: Array<number | undefined> = [];
  const gaps: Array<{ expected: number; received: number }> = [];
  const client = new GatewayBrowserClient({
    url: "ws://127.0.0.1:18789",
    onEvent: (evt) => events.push(evt.seq),
    onGap: (info) => gaps.push(info),
  });
  client.start();
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  timers.runNext();
  await flushMicrotasks();
  const connectRequest = socket.sent.find((payload) => JSON.parse(payload).method === "connect");
  assert.ok(connectRequest, "握手阶段应先发出 connect 请求");
  socket.message(
    JSON.stringify({
      type: "res",
      id: JSON.parse(connectRequest).id,
      ok: true,
      payload: { type: "hello-ok", protocol: 3 },
    }),
  );
  await flushMicrotasks();

  const frame = (seq: number) =>
    socket.message(JSON.stringify({ type: "event", event: "chat", seq, payload: {} }));
  frame(1);
  frame(2);
  frame(2); // 重复帧：丢弃
  frame(1); // 回绕帧：丢弃
  frame(4); // 前向跳号：照常投递 + 触发 onGap

  assert.deepEqual(
    events,
    [1, 2, 4],
    "重复/回绕 seq 帧不得投递给 onEvent，前向跳号帧照常投递",
  );
  assert.deepEqual(
    gaps,
    [{ expected: 3, received: 4 }],
    "仅前向跳号触发 onGap，重复/回绕帧不得误报",
  );
  client.stop();
}

// seq 编号是连接级的：断线重连（reconnectNow/自动重连）后服务端重新编号。
// 新 socket 必须重置 lastSeq——沿用旧值会把新连接上的合法帧全部当重复帧
// 静默丢弃，且无 onGap 告警。
async function testLastSeqResetsOnNewSocketConnection() {
  FakeWebSocket.instances = [];
  const timers = new FakeTimers();
  installBrowserGlobals(timers);

  const events: Array<number | undefined> = [];
  const gaps: Array<{ expected: number; received: number }> = [];
  const client = new GatewayBrowserClient({
    url: "ws://127.0.0.1:18789",
    onEvent: (evt) => events.push(evt.seq),
    onGap: (info) => gaps.push(info),
  });
  client.start();
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  timers.runNext();
  await flushMicrotasks();
  completeHello(socket);
  await flushMicrotasks();

  const frame = (s: number) =>
    socket.message(JSON.stringify({ type: "event", event: "chat", seq: s, payload: {} }));
  frame(1);
  frame(2);

  // 断线 + 手动重连：新 socket 上服务端重新从 seq 1 编号
  socket.close(1006, "lost");
  client.reconnectNow();
  const socket2 = FakeWebSocket.instances[1]!;
  socket2.open();
  timers.runNext();
  await flushMicrotasks();
  completeHello(socket2);
  await flushMicrotasks();
  const frame2 = (s: number) =>
    socket2.message(JSON.stringify({ type: "event", event: "chat", seq: s, payload: {} }));
  frame2(1);
  frame2(2);

  assert.deepEqual(
    events,
    [1, 2, 1, 2],
    "新连接重新编号的帧不得被旧 lastSeq 当重复帧丢弃",
  );
  assert.deepEqual(gaps, [], "新连接首帧无参照基准，不得误报 gap");
  client.stop();
}

async function main() {
  await testReconnectNowCancelsScheduledReconnect();
  await testRequestMustWaitForHelloHandshake();
  await testRequestTimesOutWhenGatewayNeverResponds();
  await testInvalidUrlDoesNotThrowAndGoesToReconnectPath();
  await testDuplicateOrRewindSeqFramesAreDroppedWithoutGap();
  await testLastSeqResetsOnNewSocketConnection();
  console.log("gateway reconnect tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
