import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import { resolveUserExtensionsDir } from "./constants";

export const WECOM_PLUGIN_ID = "wecom-openclaw-plugin";
export const WECOM_CHANNEL_ID = "wecom";

// 统一解析企业微信插件目录。已迁出 gateway.asar，由 extension-mirror reconcile
// 到 ~/.openclaw/extensions/wecom-openclaw-plugin/ 后由 openclaw external-plugin scan 加载。
export function resolveWecomPluginDir(): string {
  return path.join(resolveUserExtensionsDir(), WECOM_PLUGIN_ID);
}

// 检查企业微信插件是否已经随应用一起打包。
export function isWecomPluginBundled(): boolean {
  const pluginDir = resolveWecomPluginDir();
  const hasEntry =
    fs.existsSync(path.join(pluginDir, "index.ts")) ||
    fs.existsSync(path.join(pluginDir, "dist", "index.js")) ||
    fs.existsSync(path.join(pluginDir, "dist", "index.cjs.js")) ||
    fs.existsSync(path.join(pluginDir, "dist", "index.esm.js"));
  return hasEntry && fs.existsSync(path.join(pluginDir, "openclaw.plugin.json"));
}

// 企业微信凭据验证（通过 WebSocket 认证帧校验 botId + secret）。
// Electron 主进程无 WebSocket 全局，用 https + 手动 upgrade 实现。
export function verifyWecom(botId: string, secret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };

    // WebSocket 握手 key
    const wsKey = crypto.randomBytes(16).toString("base64");

    const req = https.request(
      {
        hostname: "openws.work.weixin.qq.com",
        path: "/",
        method: "GET",
        headers: {
          "Connection": "Upgrade",
          "Upgrade": "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": wsKey,
        },
        timeout: 15000,
      }
    );

    req.on("upgrade", (_res, socket) => {
      // 握手成功，发送认证帧（WebSocket text frame）
      const frame = JSON.stringify({
        cmd: "aibot_subscribe",
        headers: { req_id: `aibot_subscribe_${Date.now()}_${Math.random().toString(16).slice(2, 10)}` },
        body: { bot_id: botId, secret },
      });
      socket.write(buildWsFrame(0x1, frame));

      // 接收响应帧：按 opcode 状态机解析（分片 / ping / pong / close / 多帧同 chunk）。
      const parser = createWsFrameParser();
      socket.on("data", (chunk: Buffer) => {
        for (const event of parser.push(chunk)) {
          if (event.kind === "ping") {
            // 一次性验证连接也按协议回 pong：服务端等不到 pong 会主动断开，
            // 而认证响应可能在其后到达。
            socket.write(buildWsFrame(0xa, event.payload));
            continue;
          }
          if (event.kind === "closed") {
            socket.destroy();
            finish(new Error(`企业微信验证连接被服务端关闭: ${event.reason}`));
            return;
          }
          if (event.kind === "error") {
            socket.destroy();
            finish(new Error(`企业微信响应解析失败: ${event.message}`));
            return;
          }
          // text：完整消息已拼齐，一次性验证连接拿到即收尾
          socket.destroy();
          try {
            const data = JSON.parse(event.text);
            if (data.errcode === 0) {
              finish();
            } else {
              finish(new Error(data.errmsg || `企业微信验证失败 (errcode: ${data.errcode})`));
            }
          } catch {
            finish(new Error(`企业微信响应解析失败: ${event.text.slice(0, 200)}`));
          }
          return;
        }
      });

      socket.on("error", (e) => finish(new Error(`连接异常: ${e.message}`)));
      socket.setTimeout(10000, () => { socket.destroy(); finish(new Error("验证超时")); });
    });

    req.on("error", (e) => finish(new Error(`网络错误: ${e.message}`)));
    req.on("timeout", () => { req.destroy(); finish(new Error("连接超时")); });

    // 非 upgrade 响应（服务端拒绝）
    req.on("response", (res) => {
      res.resume();
      finish(new Error(`服务端拒绝 WebSocket 连接 (HTTP ${res.statusCode})`));
    });

    req.end();
  });
}

// 构造 WebSocket 帧（客户端发送需 mask）。opcode：0x1 text / 0xA pong 等。
function buildWsFrame(opcode: number, payload: string | Buffer): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  const mask = crypto.randomBytes(4);
  let header: Buffer;

  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN + opcode
    header[1] = 0x80 | data.length; // MASK + len
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  // 应用 mask
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    masked[i] = data[i] ^ mask[i & 3];
  }

  return Buffer.concat([header, mask, masked]);
}

// ── WebSocket 帧状态机 ──
// 服务端返回的认证响应可能分片（FIN=0 的 text + continuation 序列），也可能在
// 响应前夹带 ping/pong 控制帧；一个 TCP chunk 还可能含多个完整帧。旧实现只看
// payload 长度是否凑齐，把 ping 帧或分片首帧当完整 JSON 解析，凭据合法也报
// 「验证失败」。这里按 RFC 6455 opcode 逐帧消费，纯逻辑无 IO，便于单测。

// 帧解析事件：text 为一条完整文本消息；ping 需调用方回 pong（payload 原样带回）；
// closed/error 均为终止性事件，调用处直接结束验证。
export type WsFrameEvent =
  | { kind: "text"; text: string }
  | { kind: "ping"; payload: Buffer }
  | { kind: "closed"; reason: string }
  | { kind: "error"; message: string };

export function createWsFrameParser(): { push: (chunk: Buffer) => WsFrameEvent[] } {
  // 尚未消费完的原始字节
  let pending: Buffer = Buffer.alloc(0);
  // 进行中的分片消息缓存（null = 当前无分片消息）
  let fragments: Buffer[] | null = null;

  function fail(events: WsFrameEvent[], message: string): WsFrameEvent[] {
    events.push({ kind: "error", message });
    return events;
  }

  function parseAll(events: WsFrameEvent[]): WsFrameEvent[] {
    for (;;) {
      if (pending.length < 2) return events;
      const fin = (pending[0] & 0x80) !== 0;
      const opcode = pending[0] & 0x0f;
      const masked = (pending[1] & 0x80) !== 0;
      let payloadLen = pending[1] & 0x7f;
      let headerLen = 2;

      if (payloadLen === 126) {
        if (pending.length < 4) return events;
        payloadLen = pending.readUInt16BE(2);
        headerLen = 4;
      } else if (payloadLen === 127) {
        if (pending.length < 10) return events;
        payloadLen = Number(pending.readBigUInt64BE(2));
        headerLen = 10;
      }

      // 非法 opcode（0x3-0x7 保留、0xB-0xF 保留）：协议错误，直接终止
      const isReserved = (opcode >= 0x3 && opcode <= 0x7) || opcode >= 0xb;
      if (isReserved) {
        return fail(events, `非法 opcode 0x${opcode.toString(16)}`);
      }

      // 控制帧约束：必须 FIN=1 且 payload ≤ 125 字节
      if (opcode >= 0x8 && (!fin || payloadLen > 125)) {
        return fail(events, `非法控制帧 (opcode 0x${opcode.toString(16)}, FIN=${fin ? 1 : 0}, len=${payloadLen})`);
      }

      if (masked) headerLen += 4;
      if (pending.length < headerLen + payloadLen) return events; // payload 不完整，等更多数据

      let payload = pending.subarray(headerLen, headerLen + payloadLen);
      // RFC 6455 规定服务端帧不得带 mask；这里宽容处理并正确解码，
      // 避免对端实现瑕疵直接打断验证流程
      if (masked) {
        const maskKey = pending.subarray(headerLen - 4, headerLen);
        const unmasked = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i & 3];
        }
        payload = unmasked;
      }
      pending = pending.subarray(headerLen + payloadLen);

      if (opcode === 0x0) {
        // continuation：必须接续未完成的分片消息
        if (fragments === null) {
          return fail(events, "收到无起始帧的 continuation 分片");
        }
        fragments.push(payload);
        if (fin) {
          events.push({ kind: "text", text: Buffer.concat(fragments).toString("utf-8") });
          fragments = null;
        }
      } else if (opcode === 0x1) {
        // text：分片消息未收尾时又收到新 text 帧属协议错误
        if (fragments !== null) {
          return fail(events, "分片消息未完成又收到新的 text 帧");
        }
        if (fin) {
          events.push({ kind: "text", text: payload.toString("utf-8") });
        } else {
          fragments = [payload];
        }
      } else if (opcode === 0x2) {
        // 该连接只约定 JSON text 协议，收到 binary 视为对端异常
        return fail(events, "收到非预期的 binary 帧");
      } else if (opcode === 0x8) {
        // close：其后字节已无意义，终止解析
        const reason = payload.length > 0 ? payload.toString("utf-8") : "无原因说明";
        events.push({ kind: "closed", reason });
        return events;
      } else if (opcode === 0x9) {
        // ping：调用方需回 pong（payload 原样带回）
        events.push({ kind: "ping", payload });
      } else {
        // pong：无需处理，继续消费后续帧
      }
    }
  }

  return {
    push(chunk: Buffer): WsFrameEvent[] {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      return parseAll([]);
    },
  };
}
