"use strict";
const HOSTS = new Set(["auth.openai.com", "api.openai.com", "chatgpt.com", "api.chatgpt.com"]);
function normalizeProxyConfig(input) {
  const mode = input?.mode ?? "system";
  if (mode === "system" || mode === "direct") return { mode, url: "" };
  if (mode !== "custom") throw new Error("Invalid proxy mode");
  let url;
  try { url = new URL(String(input.url ?? "").trim()); } catch { throw new Error("请输入完整代理地址，例如 http://127.0.0.1:7890"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) throw new Error("仅支持不含账号密码、路径或参数的 HTTP(S) 代理地址");
  return { mode, url: url.origin };
}
function isOpenAIOrigin(value) {
  try { const url = new URL(value); return url.protocol === "https:" && HOSTS.has(url.hostname) && (!url.port || url.port === "443"); }
  catch { return false; }
}
module.exports = { normalizeProxyConfig, isOpenAIOrigin };
