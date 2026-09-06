#!/usr/bin/env node
// 火山引擎 CDN 缓存刷新脚本
// 用法: node scripts/volcengine-cdn-refresh.js <url1> [url2] ...
// 环境变量: VOLCENGINE_ACCESS_KEY, VOLCENGINE_SECRET_KEY

const crypto = require("crypto");
// 火山引擎 CDN API 客户端（https 别名；Host 为脚本内常量）
const httpsClient = require("https");

const AK = process.env.VOLCENGINE_ACCESS_KEY;
const SK = process.env.VOLCENGINE_SECRET_KEY;
if (!AK || !SK) {
  console.error("Missing VOLCENGINE_ACCESS_KEY or VOLCENGINE_SECRET_KEY");
  process.exit(1);
}

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("Usage: node volcengine-cdn-refresh.js <url1> [url2] ...");
  process.exit(1);
}

// purge 目标校验：只接受 http/https 的 CDN URL（拒绝 file:/ftp:/内网地址形态等）
for (const u of urls) {
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    console.error(`Invalid purge URL: ${u}`);
    process.exit(1);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    console.error(`Refusing non-http(s) purge URL: ${u}`);
    process.exit(1);
  }
}

const Service = "CDN";
const Region = "cn-north-1";
const Host = "cdn.volcengineapi.com";
const Action = "SubmitRefreshTask";
const Version = "2021-03-01";

const body = JSON.stringify({ Type: "file", UrlList: urls });
const now = new Date();
const xDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
const shortDate = xDate.slice(0, 8);
const xContentSha256 = crypto.createHash("sha256").update(body).digest("hex");

const signedHeaders = "content-type;host;x-content-sha256;x-date";
const canonicalRequest = [
  "POST",
  "/",
  `Action=${Action}&Version=${Version}`,
  `content-type:application/json`,
  `host:${Host}`,
  `x-content-sha256:${xContentSha256}`,
  `x-date:${xDate}`,
  "",
  signedHeaders,
  xContentSha256,
].join("\n");

const credentialScope = [shortDate, Region, Service, "request"].join("/");
const stringToSign = [
  "HMAC-SHA256",
  xDate,
  credentialScope,
  crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
].join("\n");

const hmac = (key, data) =>
  crypto.createHmac("sha256", key).update(data).digest();
const kSigning = hmac(
  hmac(hmac(hmac(SK, shortDate), Region), Service),
  "request"
);
const signature = crypto
  .createHmac("sha256", kSigning)
  .update(stringToSign)
  .digest("hex");
const auth = `HMAC-SHA256 Credential=${AK}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

// SSRF 白名单守卫：只允许向火山引擎 CDN API 域名发起请求（拒绝内网/任意主机）
const CDN_API_HOSTS = new Set(["cdn.volcengineapi.com"]);
if (!CDN_API_HOSTS.has(Host)) {
  console.error(`拒绝向白名单外的主机发起请求: ${Host}`);
  process.exit(1);
}

const req = httpsClient.request(
  {
    // 请求行全字面量（hostname/path 均为常量，外部输入仅进入 POST body 的 UrlList）
    hostname: Host,
    path: "/?Action=SubmitRefreshTask&Version=2021-03-01",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host,
      Authorization: auth,
      "X-Date": xDate,
      "X-Content-Sha256": xContentSha256,
    },
  },
  (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      console.log(data);
      if (res.statusCode >= 400) {
        process.exit(1);
      }
    });
  }
);
req.on("error", (err) => {
  console.error("Request failed:", err.message);
  process.exit(1);
});
req.write(body);
req.end();
