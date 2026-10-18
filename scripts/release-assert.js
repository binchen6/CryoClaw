#!/usr/bin/env node
/**
 * release-assert.js — 发版后硬断言：指定 tag 的 GitHub Release 资产齐全且自洽。
 *
 * 背景：v2026.1013.0 曾只传了 .exe（漏 blockmap/latest.yml），导致所有客户端
 * 检查更新 404。本脚本把「三件套同批进同一 Release」从人工核对变成硬门槛。
 *
 * 用法：
 *   node scripts/release-assert.js [version]     # 默认取 package.json version
 *   node scripts/release-assert.js 2026.1013.0 --allow-draft   # 草稿期核对
 *   node scripts/release-assert.js --deep        # 加验：下载 exe 核对 sha512（慢）
 *
 * 检查项：
 *   1. Release 存在；非 draft（除非 --allow-draft）
 *   2. 必含三资产：CryoClaw-Setup-<v>-x64.exe / 同名 .exe.blockmap / latest.yml
 *   3. latest.yml 可下载、可解析，且 version == package.json version
 *   4. latest.yml 的 files[0] 文件名与 exe 资产名一致
 *   5. --deep：下载 exe 重算 sha512（base64，与 latest.yml 一致）
 *
 * 退出码 0 = 全过；非 0 = 任何一项不过（不得宣发）。
 * 认证：GH_TOKEN 环境变量（可选；public 仓库只读可匿名，但带 token 避免限流）。
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const OWNER = "binchen6";
const REPO = "CryoClaw";

function die(msg) {
  console.error(`\n✗ release-assert 失败: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`✔ ${msg}`);
}

function requestHeaders(url, accept, token = process.env.GH_TOKEN) {
  const headers = { "User-Agent": "cryoclaw-release-assert", Accept: accept };
  const target = new URL(url);
  if (target.protocol === "https:" && target.hostname === "api.github.com" && token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function assetDownloadUrl(release, asset) {
  return release.draft ? asset.url : asset.browser_download_url;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const headers = requestHeaders(url, "application/vnd.github+json");
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume();
          return fetchJson(new URL(res.headers.location, url).href).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

function fetchBuffer(url, maxBytes) {
  return new Promise((resolve, reject) => {
    const headers = requestHeaders(url, "application/octet-stream");
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return fetchBuffer(new URL(res.headers.location, url).href, maxBytes).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (maxBytes && size > maxBytes) {
            res.destroy();
            return reject(new Error(`下载超过上限 ${maxBytes}B`));
          }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const allowDraft = args.includes("--allow-draft");
  const deep = args.includes("--deep");
  const versionArg = args.find((a) => !a.startsWith("--"));

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
  const version = versionArg ?? pkg.version;
  const tag = `v${version}`;
  console.log(`release-assert: ${OWNER}/${REPO} ${tag}\n`);

  // 1. Release 存在 + draft 状态
  // Draft tags are not necessarily created yet; resolve them from the authenticated list.
  const releasesUrl = `https://api.github.com/repos/${OWNER}/${REPO}/releases`;
  const rel = await (allowDraft
    ? fetchJson(`${releasesUrl}?per_page=100`).then((releases) => releases.find((release) => release.tag_name === tag))
    : fetchJson(`${releasesUrl}/tags/${encodeURIComponent(tag)}`)
  ).catch((e) => die(`Release ${tag} 不存在或不可达: ${e.message}`));
  if (!rel) die(`Release ${tag} 不存在`);
  if (rel.draft && !allowDraft) die("Release 仍是 draft（草稿期核对请加 --allow-draft）");
  ok(`Release 存在（draft=${rel.draft}）`);

  // 2. 三件套资产
  const assetNames = (rel.assets ?? []).map((a) => a.name);
  const exeName = `CryoClaw-Setup-${version}-x64.exe`;
  const required = [exeName, `${exeName}.blockmap`, "latest.yml"];
  const missing = required.filter((n) => !assetNames.includes(n));
  if (missing.length > 0) {
    die(`缺资产: ${missing.join(", ")}\n  实际资产: ${assetNames.join(", ") || "(无)"}`);
  }
  ok(`三件套齐全: ${required.join(", ")}`);

  // 3. latest.yml 下载 + 解析 + 版本一致
  const ymlAsset = rel.assets.find((a) => a.name === "latest.yml");
  const ymlBuf = await fetchBuffer(assetDownloadUrl(rel, ymlAsset), 256 * 1024).catch((e) =>
    die(`latest.yml 下载失败: ${e.message}`),
  );
  let yml;
  try {
    yml = require("js-yaml").load(ymlBuf.toString("utf-8"));
  } catch (e) {
    die(`latest.yml 解析失败: ${e.message}`);
  }
  if (yml?.version !== version) {
    die(`latest.yml version=${yml?.version} ≠ package.json version=${version}`);
  }
  ok(`latest.yml version=${yml.version} 一致`);

  // 4. latest.yml files[0] 与 exe 资产名一致
  const file0 = Array.isArray(yml.files) ? yml.files[0] : null;
  const ymlExeName = file0?.url ?? file0?.name ?? "";
  if (ymlExeName !== exeName) {
    die(`latest.yml files[0]=${ymlExeName} ≠ 期望 ${exeName}`);
  }
  ok(`latest.yml files[0] 指向 ${exeName}`);

  // 5. --deep：重算 exe sha512 与 latest.yml 一致
  if (deep) {
    const exeAsset = rel.assets.find((a) => a.name === exeName);
    console.log(`下载 ${exeName}（${(exeAsset.size / 1048576).toFixed(0)}MB）校验 sha512…`);
    const exeBuf = await fetchBuffer(assetDownloadUrl(rel, exeAsset), 0).catch((e) =>
      die(`exe 下载失败: ${e.message}`),
    );
    const crypto = require("crypto");
    const sha512 = crypto.createHash("sha512").update(exeBuf).digest("base64");
    if (sha512 !== file0.sha512 && sha512 !== yml.sha512) {
      die(`exe sha512 不匹配 latest.yml`);
    }
    ok(`exe sha512 与 latest.yml 一致`);
  }

  console.log(`\n✓ ${tag} 资产断言全部通过`);
}

module.exports = { requestHeaders, assetDownloadUrl };
if (require.main === module) main().catch((e) => die(e.message));
