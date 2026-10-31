"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");

const STAMP = ".cryoclaw-build-deps.json";
function optionalFile(file) {
  try { return fs.readFileSync(file); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}
function inputHash(root, env = process.env) {
  const hash = createHash("sha256");
  const config = Object.entries(env).filter(([key]) => /^npm_config_/i.test(key) || key === "NODE_ENV")
    .sort(([a], [b]) => a.localeCompare(b));
  hash.update(JSON.stringify({ schema: 1, node: process.version, arch: process.arch, platform: process.platform, config }));
  for (const file of [path.join(root, "package.json"), path.join(root, "package-lock.json"), path.join(root, ".npmrc"),
    env.npm_config_userconfig || env.NPM_CONFIG_USERCONFIG || path.join(os.homedir(), ".npmrc"),
    env.npm_config_globalconfig || env.NPM_CONFIG_GLOBALCONFIG]) {
    if (!file) continue;
    const bytes = optionalFile(file);
    hash.update(String(bytes.length));
    hash.update(bytes);
  }
  return hash.digest("hex");
}
function installedTree(root) {
  const hidden = fs.readFileSync(path.join(root, "node_modules", ".package-lock.json"));
  const lock = JSON.parse(hidden);
  if (lock.lockfileVersion < 2 || !lock.packages || !Object.keys(lock.packages).length) return null;
  // Use npm's installed inventory, not all lock entries: foreign optional native
  // packages are deliberately absent. A stamp also binds the entire inventory.
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (!relative.startsWith("node_modules/") || relative.split(/[\\/]/).includes("..") || entry.link) return null;
    const manifest = JSON.parse(fs.readFileSync(path.join(root, relative, "package.json"), "utf8"));
    if (manifest.version !== entry.version) return null;
    const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin || {});
    for (const bin of bins) if (!fs.statSync(path.join(root, relative, bin)).isFile()) return null;
  }
  if (!fs.statSync(path.join(root, "node_modules", "vite", "bin", "vite.js")).isFile()) return null;
  return createHash("sha256").update(hidden).digest("hex");
}
function canReuseDependencies(root, env = process.env) {
  if (env.CRYOCLAW_FORCE_CHAT_INSTALL === "1") return false;
  // npm run exposes the effective globalconfig path, including defaults and
  // prefix overrides. Outside npm we cannot safely infer that configuration.
  if (!(env.npm_config_globalconfig || env.NPM_CONFIG_GLOBALCONFIG)) return false;
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(root, "node_modules", STAMP), "utf8"));
    return stamp.inputs === inputHash(root, env) && stamp.installed === installedTree(root);
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError || error.code === "ENOTDIR") return false;
    throw error;
  }
}
function ensureDependencies(root, install, env = process.env) {
  if (canReuseDependencies(root, env)) return { reused: true };
  const stamp = path.join(root, "node_modules", STAMP);
  fs.rmSync(stamp, { force: true });
  // Keep npm's registry integrity verification and install lifecycle unchanged.
  install();
  const installed = installedTree(root);
  if (!installed) throw new Error("Chat UI dependency tree is incomplete after npm install");
  fs.writeFileSync(stamp, JSON.stringify({ inputs: inputHash(root, env), installed }));
  return { reused: false };
}
module.exports = { canReuseDependencies, ensureDependencies, inputHash };
