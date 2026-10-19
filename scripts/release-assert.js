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
 *   node scripts/release-assert.js --deep        # 流式下载 exe 核对 sha512（有超时）
 *   node scripts/release-assert.js --local-dir out/win32-x64 # 对比 GitHub 服务端 SHA-256
 *
 * 检查项：
 *   1. Release 存在；非 draft（除非 --allow-draft）
 *   2. 必含三资产：CryoClaw-Setup-<v>-x64.exe / 同名 .exe.blockmap / latest.yml
 *   3. latest.yml 可下载、可解析，且 version == package.json version
 *   4. latest.yml 每条文件的资产、blockmap、大小与 sha512 自洽
 *   5. --deep：下载 exe 重算 sha512（base64，与 latest.yml 一致）
 *
 * 退出码 0 = 全过；非 0 = 任何一项不过（不得宣发）。
 * 认证：GH_TOKEN 环境变量（可选；public 仓库只读可匿名，但带 token 避免限流）。
 */
const fs = require("fs");
const path = require("path");
const {fetchBytes,hashDownload} = require("./lib/release-network");
const {verifyLocalAssets} = require("./lib/release-local-assets");

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

function validateManifest(yml, version, assets) {
  if (yml?.version !== version) throw new Error(`latest.yml version 不匹配 ${version}`);
  if (!Array.isArray(yml.files) || !yml.files.length) throw new Error("latest.yml files 为空");
  const seen = new Set();
  for (const file of yml.files) {
    if (!file || typeof file.url !== "string" || seen.has(file.url)) throw new Error("latest.yml 文件名缺失或重复");
    seen.add(file.url);
    const asset = assets.find(a => a.name === file.url);
    if (!asset || !assets.some(a => a.name === `${file.url}.blockmap`)) throw new Error(`缺安装器或 blockmap: ${file.url}`);
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size !== asset.size) throw new Error(`安装器大小不匹配: ${file.url}`);
    if (typeof file.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) throw new Error(`无效 sha512: ${file.url}`);
  }
  const expected = `CryoClaw-Setup-${version}-x64.exe`;
  const file = yml.files.find(f => f.url === expected);
  if (!file) throw new Error(`latest.yml 缺少 ${expected}`);
  if (yml.path != null) {
    const primary = yml.files.find(f => f.url === yml.path);
    if (!primary || yml.sha512 !== primary.sha512) throw new Error("latest.yml 顶层 path/sha512 与 files 不一致");
  }
  return file;
}

async function fetchJson(url) {
  const data=await fetchBytes(url,{headers:u=>requestHeaders(u,"application/vnd.github+json"),totalMs:60_000,maxBytes:8*1024*1024});
  return JSON.parse(data.toString("utf8"));
}
function fetchBuffer(url,maxBytes) {
  return fetchBytes(url,{headers:u=>requestHeaders(u,"application/octet-stream"),maxBytes,totalMs:60_000});
}

async function main() {
  const args = process.argv.slice(2);
  const allowDraft = args.includes("--allow-draft");
  const deep = args.includes("--deep");
  let versionArg,localDir;
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==="--local-dir"){if(!args[i+1] || args[i+1].startsWith("--"))throw Error("--local-dir requires a directory");localDir=args[++i];}
    else if(arg==="--deep" || arg==="--allow-draft")continue;
    else if(arg.startsWith("--") || versionArg)throw Error("Unknown release argument: "+arg);
    else versionArg=arg;
  }

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
  const assetNames = (rel.assets ?? []).filter(a=>a.state==="uploaded").map((a) => a.name);
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

  // 4. 验证全部架构，并按文件名查找 x64（清单排序不限）。
  const file0 = validateManifest(yml, version, rel.assets);
  const ymlExeName = file0?.url ?? file0?.name ?? "";
  if (ymlExeName !== exeName) {
    die(`latest.yml 安装器=${ymlExeName} ≠ 期望 ${exeName}`);
  }
  ok(`latest.yml 资产大小及校验和一致，包含 ${exeName}`);

  // 5. --deep：重算 exe sha512 与 latest.yml 一致
  if (deep) {
    const exeAsset = rel.assets.find((a) => a.name === exeName);
    console.log(`下载 ${exeName}（${(exeAsset.size / 1048576).toFixed(0)}MB）校验 sha512…`);
    const result=await hashDownload(assetDownloadUrl(rel,exeAsset),{
      headers:u=>requestHeaders(u,"application/octet-stream"),maxBytes:exeAsset.size,
    });
    if(result.size!==exeAsset.size || result.sha512!==file0.sha512)die("exe sha512 或大小不匹配 latest.yml");
    ok(`exe sha512 与 latest.yml 一致`);
  }

  if(localDir){
    await verifyLocalAssets(rel.assets,localDir,required,{[file0.url]:file0.sha512});
    ok("本地三件套与 GitHub 服务端 SHA-256 及大小一致");
  }
  console.log(`\n✓ ${tag} 资产断言全部通过`);
}

module.exports = { requestHeaders, assetDownloadUrl, validateManifest };
if (require.main === module) main().catch((e) => die(e.message));
