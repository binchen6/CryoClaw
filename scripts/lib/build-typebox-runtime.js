"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { SCHEMA, TYPEBOX_SOURCE_DIGESTS, sha256, treeDigest, readPackage, validateRecipe, recoverTypeboxRuntime, applyTypeboxRuntime } = require("./compact-typebox-runtime");

// This is a distribution transformation, not a general-purpose dependency
// bundler. A different upstream release stays untouched until reviewed/tested.
const PUBLIC_ENTRIES = ["compile", "error", "format", "guard", "schema", "system", "type", "value"];

async function buildTypeboxRuntime(gatewayDir, recipeFile) {
  if (process.env.CRYOCLAW_COMPACT_TYPEBOX === "0") return { action: "disabled" };
  if (fs.existsSync(recipeFile)) {
    const recipe = JSON.parse(fs.readFileSync(recipeFile, "utf8"));
    validateRecipe(recipe);
    recoverTypeboxRuntime(gatewayDir, recipe);
  }
  let current;
  try { current = readPackage(gatewayDir); } catch { return { action: "unsupported" }; }
  const { root, manifest, pkg, files } = current;
  const sourceDigest = TYPEBOX_SOURCE_DIGESTS[pkg.version];
  const expected = Object.fromEntries([...PUBLIC_ENTRIES.map(name => [`./${name}`, { import: `./build/${name}/index.mjs`, default: `./build/${name}/index.mjs` }]), [".", { import: "./build/index.mjs", default: "./build/index.mjs" }]]);
  if (pkg.name !== "typebox" || !sourceDigest || pkg.type !== "module" || pkg.bin || pkg.imports ||
      JSON.stringify(pkg.exports) !== JSON.stringify(expected)) return { action: "unsupported" };
  const digest = treeDigest(files);
  if (fs.existsSync(recipeFile)) {
    const recipe = JSON.parse(fs.readFileSync(recipeFile, "utf8"));
    validateRecipe(recipe);
    if (recipe.manifestSha256 === sha256(manifest) && recipe.sourceDigest === sourceDigest && recipe.outputDigest === digest) return { action: "reused", before: files.length, after: files.length };
  }
  if (digest !== sourceDigest) return { action: "source-changed" };
  const build = path.join(root, "build");
  const result = await require("esbuild").build({
    absWorkingDir: root,
    entryPoints: ["index.mjs", ...PUBLIC_ENTRIES.map(name => `${name}/index.mjs`)].map(name => path.join(build, name)),
    outbase: build, outdir: path.join(root, "cryoclaw-output"), outExtension: { ".js": ".mjs" },
    bundle: true, splitting: true, platform: "node", format: "esm", target: "node22",
    // Preserve public function names and initialization side effects. One shared
    // chunk graph retains registry/class identity across all public subpaths.
    keepNames: true, treeShaking: false, ignoreAnnotations: true,
    metafile: true, write: false, logLevel: "silent",
  });
  const external = Object.values(result.metafile.outputs).flatMap(output => output.imports.filter(item => item.external));
  if (result.warnings.length || external.length) throw Error(`Unexpected TypeBox bundle dependency or warning: ${JSON.stringify({ warnings: result.warnings, external })}`);
  const outputs = result.outputFiles.map(file => ({ path: path.relative(path.join(root, "cryoclaw-output"), file.path).split(path.sep).join("/"), content: file.text })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const recipe = { schema: SCHEMA, name: pkg.name, version: pkg.version, manifestSha256: sha256(manifest), sourceDigest: digest, outputDigest: treeDigest(outputs), files: outputs };
  validateRecipe(recipe);
  const probe = path.join(root, `.cryoclaw-probe-${randomUUID()}`);
  if (path.dirname(probe) !== root) throw Error("Invalid TypeBox probe path");
  try {
    for (const file of outputs) {
      const target = path.join(probe, "build", file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    const checked = spawnSync(process.execPath, [path.join(__dirname, "..", "typebox-runtime-smoke.mjs"), root, probe], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    if (checked.error || checked.status !== 0) throw Error(`TypeBox runtime parity failed: ${checked.error?.message ?? checked.stderr}`);
  } finally {
    if (fs.existsSync(probe)) fs.rmSync(probe, { recursive: true });
  }
  fs.mkdirSync(path.dirname(recipeFile), { recursive: true });
  fs.writeFileSync(recipeFile, JSON.stringify(recipe));
  return applyTypeboxRuntime(gatewayDir, recipeFile);
}

module.exports = { buildTypeboxRuntime, TYPEBOX_SOURCE_DIGESTS };
