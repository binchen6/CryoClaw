import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const parameters = {
  type: "object", additionalProperties: false, required: ["action"], properties: {
    action: { type: "string", enum: ["status", "navigate", "back", "forward", "reload", "snapshot", "evaluate", "click", "type", "scroll"] },
    url: { type: "string", maxLength: 8192 },
    script: { type: "string", maxLength: 50000 },
    selector: { type: "string", maxLength: 4096 },
    text: { type: "string", maxLength: 100000 },
    x: { type: "number", minimum: -20000, maximum: 20000 },
    y: { type: "number", minimum: -20000, maximum: 20000 },
  },
};

export async function requestEmbeddedBrowser(args, options = {}) {
  const { signal, assertCurrent = () => {}, fetchImpl = fetch } = options;
  assertCurrent();
  if (signal?.aborted) throw Error("Browser operation canceled");
  const stateDir = options.stateDir || process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  const config = JSON.parse(await fs.readFile(path.join(stateDir, "cryoclaw.config.json"), "utf8"));
  const port = config.gatewayControl?.port;
  const token = config.gatewayControl?.token;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== "string" || !token) {
    throw Error("CryoClaw browser control is unavailable");
  }
  const signals = [AbortSignal.timeout(20000)];
  if (signal) signals.push(signal);
  const response = await fetchImpl(`http://127.0.0.1:${port}/ui/browser`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.any(signals),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) throw Error(String(payload?.error || `Browser control failed (${response.status})`).slice(0, 500));
  assertCurrent();
  return payload.result;
}

export default {
  id: "cryoclaw-browser", name: "CryoClaw Embedded Browser",
  register(api) {
    api.registerTool({ contextVersion: 2, create(ctx) {
      if (ctx.sandboxed || (ctx.messageChannel && !["webchat", "webchat-ui"].includes(ctx.messageChannel))) return null;
      return {
        name: "cryoclaw_browser", label: "Embedded browser",
        description: "Control CryoClaw's isolated in-app browser with live preview in the right dock. Use status first: when priority is builtin, prefer this tool for ordinary browsing; when priority is webbridge or kernel, use the configured external browser unless the user explicitly asks for the embedded browser. Supports HTTP(S) navigation, readable snapshots, CSS-selector click/type, scrolling and JavaScript evaluation. Requires the user's embedded-browser Agent setting.",
        parameters,
        async execute(_id, args, signal) {
          const result = await requestEmbeddedBrowser(args, { signal, assertCurrent: ctx.assertInvocationCurrent });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
      };
    } }, { optional: true });
  },
};
