"use strict";

// Applied only to an offline build/update staging tree. The gateway continues to
// perform its normal source capture, hashing, path admission and generation checks.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const SCHEMA = 1;
const TYPEBOX_SOURCE_DIGESTS = Object.freeze({
  "1.3.34": "c890f8d847db306cbe1f7e5cf526157881d93a96c3181e6ba61417cc30768ae4",
  "1.3.35": "070dfbccb1070adf62edfe114d5a5b7dd1dd2b6d84086e1a42e851f0dd294266",
});
const sha256 = value => createHash("sha256").update(value).digest("hex");

function safeRelative(name) {
  return typeof name === "string" && /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.mjs$/.test(name);
}

function readTree(directory) {
  const files = [];
  function walk(dir) {
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw Error("Linked runtime directory");
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push({ path: path.relative(directory, file).split(path.sep).join("/"), content: fs.readFileSync(file, "utf8") });
      else throw Error("Non-regular runtime source");
    }
  }
  walk(directory);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function treeDigest(files) {
  return sha256(JSON.stringify(files.map(file => [file.path, sha256(file.content)])));
}

function packageRoot(gatewayDir) {
  const root = path.resolve(gatewayDir, "node_modules", "typebox");
  // Do not traverse package junctions, including a linked node_modules ancestor.
  if (path.relative(root, fs.realpathSync.native(root)) !== "" || fs.lstatSync(root).isSymbolicLink()) throw Error("Linked TypeBox package");
  return root;
}

function readPackage(gatewayDir) {
  const root = packageRoot(gatewayDir);
  const manifest = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const pkg = JSON.parse(manifest);
  return { root, manifest, pkg, files: readTree(path.join(root, "build")) };
}

function recoverTypeboxRuntime(gatewayDir, recipe) {
  let root;
  try { root = packageRoot(gatewayDir); } catch { return; }
  const backups = fs.readdirSync(root).filter(name => /^\.cryoclaw-build-[a-f0-9-]{36}\.original$/.test(name));
  if (!backups.length) return;
  if (backups.length !== 1 || sha256(fs.readFileSync(path.join(root, "package.json"), "utf8")) !== recipe.manifestSha256) throw Error("Ambiguous TypeBox layout recovery; rebuild the staging tree");
  const backup = path.join(root, backups[0]), build = path.join(root, "build");
  if (treeDigest(readTree(backup)) !== recipe.sourceDigest) throw Error("TypeBox recovery source changed; rebuild the staging tree");
  if (!fs.existsSync(build)) fs.renameSync(backup, build);
  else {
    if (treeDigest(readTree(build)) !== recipe.outputDigest) throw Error("TypeBox recovery output changed; rebuild the staging tree");
    fs.rmSync(backup, { recursive: true });
  }
  const staged = backup.slice(0, -".original".length);
  if (fs.existsSync(staged)) {
    if (treeDigest(readTree(staged)) !== recipe.outputDigest) throw Error("TypeBox recovery staging changed; rebuild the staging tree");
    fs.rmSync(staged, { recursive: true });
  }
}

function validateRecipe(recipe) {
  if (recipe?.schema !== SCHEMA || recipe.name !== "typebox" || !Object.hasOwn(TYPEBOX_SOURCE_DIGESTS, recipe.version) ||
      !/^[a-f0-9]{64}$/.test(recipe.manifestSha256) || !/^[a-f0-9]{64}$/.test(recipe.sourceDigest) ||
      !Array.isArray(recipe.files) || !recipe.files.length || recipe.files.length > 64) throw Error("Invalid TypeBox runtime recipe");
  const names = new Set();
  let bytes = 0;
  for (const file of recipe.files) {
    if (!safeRelative(file.path) || names.has(file.path) || typeof file.content !== "string") throw Error("Invalid TypeBox runtime output");
    names.add(file.path); bytes += Buffer.byteLength(file.content);
  }
  if (bytes > 4 * 1024 * 1024 || treeDigest(recipe.files) !== recipe.outputDigest) throw Error("Corrupt TypeBox runtime output");
}

function applyTypeboxRuntime(gatewayDir, recipeFile, options = {}) {
  if (process.env.CRYOCLAW_COMPACT_TYPEBOX === "0") return { action: "disabled" };
  if (!fs.existsSync(recipeFile)) return { action: "unavailable" };
  const recipe = JSON.parse(fs.readFileSync(recipeFile, "utf8"));
  validateRecipe(recipe);
  recoverTypeboxRuntime(gatewayDir, recipe);
  let current;
  try { current = readPackage(gatewayDir); } catch { return { action: "unsupported" }; }
  if (current.pkg.name !== recipe.name || current.pkg.version !== recipe.version || sha256(current.manifest) !== recipe.manifestSha256) return { action: "unsupported" };
  const digest = treeDigest(current.files);
  if (digest === recipe.outputDigest) return { action: "reused", before: current.files.length, after: current.files.length };
  if (digest !== recipe.sourceDigest) return { action: "source-changed" };

  const build = path.join(current.root, "build");
  const staged = path.join(current.root, `.cryoclaw-build-${randomUUID()}`);
  const backup = `${staged}.original`;
  // All recursive operations below target unique, checked children of this one
  // staged package. Never remove the original until replacement has succeeded.
  for (const target of [staged, backup]) {
    if (path.dirname(target) !== current.root) throw Error("Invalid runtime staging path");
  }
  fs.mkdirSync(staged);
  let moved = false;
  try {
    for (const file of recipe.files) {
      const target = path.join(staged, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    if (treeDigest(readTree(staged)) !== recipe.outputDigest) throw Error("Runtime staging verification failed");
    // An optional fault injector is used by transaction tests only.
    const rename = options.rename ?? fs.renameSync;
    rename(build, backup); moved = true;
    try { rename(staged, build); } catch (error) { fs.renameSync(backup, build); moved = false; throw error; }
    fs.rmSync(backup, { recursive: true }); moved = false;
    return { action: "compacted", before: current.files.length, after: recipe.files.length };
  } finally {
    if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true });
    // Keep the backup on an unexpected rollback/cleanup failure for diagnosis.
    if (moved && !fs.existsSync(build)) fs.renameSync(backup, build);
  }
}

module.exports = { SCHEMA, TYPEBOX_SOURCE_DIGESTS, sha256, treeDigest, readTree, readPackage, validateRecipe, recoverTypeboxRuntime, applyTypeboxRuntime };
