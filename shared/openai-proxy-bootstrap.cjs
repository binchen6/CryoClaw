"use strict";
// Loaded only in the gateway. No OAuth credentials are read or modified here.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
// Windows can stop the process tree forcibly. Persist on graceful shutdown and
// once after startup; synchronous cache writes must not interrupt admission.
const nodeModule = require("node:module");
try {
  require("./gateway-core-resolution-cache.cjs").installCoreResolutionCache(process.env.CRYOCLAW_OPENAI_GATEWAY_ROOT);
} catch (error) {
  console.warn(`[core-resolution] cache unavailable: ${error.message}`);
}
if (typeof process.send === "function") {
  let stopping = false;
  process.on("message", message => {
    if (stopping || message?.type !== "cryoclaw:shutdown" || process.listenerCount("SIGTERM") === 0) return;
    stopping = true;
    // Windows kill(SIGTERM) terminates the process without running JS handlers.
    // The private parent IPC channel enters the native graceful shutdown path.
    process.emit("SIGTERM");
  });
  process.once("disconnect", () => {
    if (stopping) return;
    stopping = true;
    if (process.listenerCount("SIGTERM") > 0) process.emit("SIGTERM");
    else process.exit(0);
  });
}
// Standalone Node persists this cache itself, including explicit process.exit().
// Keep the old hook only for Electron, avoiding a redundant native exit listener.
if (process.versions?.electron && process.env.NODE_COMPILE_CACHE && process.env.NODE_DISABLE_COMPILE_CACHE === undefined
  && typeof nodeModule.flushCompileCache === "function") {
  const flush = () => { try { nodeModule.flushCompileCache(); } catch { /* cache is optional */ } };
  process.once("exit", flush);
  setTimeout(flush, 180_000).unref();
}
const { normalizeProxyConfig, isOpenAIOrigin } = require("./openai-proxy.cjs");
const configPath = process.env.CRYOCLAW_OPENAI_PROXY_CONFIG;
if (configPath && process.env.CRYOCLAW_OPENAI_GATEWAY_ROOT) {
  const config = normalizeProxyConfig(fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")).openaiProxy : undefined);
  if (config.mode !== "system") {
    const kernelRequire = createRequire(path.join(process.env.CRYOCLAW_OPENAI_GATEWAY_ROOT, "package.json"));
    const undici = kernelRequire("undici");
    const { Agent, ProxyAgent, fetch: proxyFetch, Request: ProxyRequest } = undici;
    const dispatcher = config.mode === "custom" ? new ProxyAgent(config.url) : new Agent();
    const observedHosts = new Set();
    const original = globalThis.fetch;
    function scopedFetch(input, init, fallbackFetch) {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (!isOpenAIOrigin(url)) return fallbackFetch(input, init);
      const hostname = new URL(url).hostname;
      if (!observedHosts.has(hostname)) {
        observedHosts.add(hostname);
        console.info(`[openai-proxy] route=${config.mode} host=${hostname}`);
      }
      const fallback = init?.dispatcher ?? kernelRequire("undici").getGlobalDispatcher();
      const scoped = { dispatch(options, handler) {
        return (isOpenAIOrigin(String(options.origin)) ? dispatcher : fallback).dispatch(options, handler);
      } };
      // Use fetch and dispatcher from the same undici build. Electron's built-in
      // fetch can use a different dispatcher-handler ABI than the bundled kernel.
      const request = typeof input === "string" || input instanceof URL ? input
        : new ProxyRequest(input.url, { method:input.method, headers:input.headers,
          body:["GET","HEAD"].includes(input.method) ? undefined : input.body,
          duplex:"half", signal:input.signal, redirect:input.redirect });
      return proxyFetch(request, { ...init, dispatcher: scoped });
    }
    globalThis.fetch = (input, init) => scopedFetch(input, init, original);
    // OAuth's SSRF guard calls the kernel's undici runtime directly, bypassing
    // global fetch. Install before kernel imports take their runtime snapshot.
    undici.fetch = (input, init) => scopedFetch(input, init, proxyFetch);
  }
}
