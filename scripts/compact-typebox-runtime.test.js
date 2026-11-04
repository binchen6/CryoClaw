"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SCHEMA, sha256, treeDigest, readTree, applyTypeboxRuntime } = require("./lib/compact-typebox-runtime");

function fixture(t, version = "1.3.34") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-compact-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "node_modules/typebox"), build = path.join(root, "build");
  fs.mkdirSync(build, { recursive: true });
  const manifest = JSON.stringify({ name: "typebox", version, type: "module" });
  fs.writeFileSync(path.join(root, "package.json"), manifest);
  fs.writeFileSync(path.join(build, "index.mjs"), "export {value} from './value.mjs';");
  fs.writeFileSync(path.join(build, "value.mjs"), "export const value = 1;");
  const before = readTree(build), files = [{ path: "index.mjs", content: "export const value = 1;" }];
  const recipe = { schema: SCHEMA, name: "typebox", version, manifestSha256: sha256(manifest), sourceDigest: treeDigest(before), outputDigest: treeDigest(files), files };
  const recipeFile = path.join(dir, "recipe.json");
  const save = () => fs.writeFileSync(recipeFile, JSON.stringify(recipe)); save();
  return { dir, root, build, before, recipe, recipeFile, save };
}

for (const version of ["1.3.34", "1.3.35"]) test(`${version} offline layout replacement is idempotent and preserves package metadata`, t => {
  const f = fixture(t, version), manifest = fs.readFileSync(path.join(f.root, "package.json"), "utf8");
  assert.deepEqual(applyTypeboxRuntime(f.dir, f.recipeFile), { action: "compacted", before: 2, after: 1 });
  assert.equal(applyTypeboxRuntime(f.dir, f.recipeFile).action, "reused");
  assert.equal(fs.readFileSync(path.join(f.root, "package.json"), "utf8"), manifest);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ["build", "package.json"]);
});

for (const mutation of ["source", "extra-file", "manifest", "version"]) test(`changed ${mutation} retains upstream files`, t => {
  const f = fixture(t);
  if (mutation === "source") fs.appendFileSync(path.join(f.build, "value.mjs"), "\n// edited");
  if (mutation === "extra-file") fs.writeFileSync(path.join(f.build, "extra.mjs"), "export {};");
  if (mutation === "manifest" || mutation === "version") fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "typebox", version: mutation === "version" ? "2.0.0" : "1.3.34", extra: true }));
  const before = readTree(f.build);
  assert.ok(["source-changed", "unsupported"].includes(applyTypeboxRuntime(f.dir, f.recipeFile).action));
  assert.deepEqual(readTree(f.build), before);
});

for (const mutation of ["corrupt", "escape", "absolute", "duplicate", "schema"]) test(`invalid ${mutation} recipe never touches the source`, t => {
  const f = fixture(t);
  if (mutation === "corrupt") f.recipe.files[0].content += "broken";
  if (mutation === "escape") f.recipe.files[0].path = "../outside.mjs";
  if (mutation === "absolute") f.recipe.files[0].path = "C:/outside.mjs";
  if (mutation === "duplicate") f.recipe.files.push(f.recipe.files[0]);
  if (mutation === "schema") f.recipe.schema = 2;
  f.save();
  assert.throws(() => applyTypeboxRuntime(f.dir, f.recipeFile));
  assert.deepEqual(readTree(f.build), f.before);
});

test("a failed replacement rename restores the complete original tree", t => {
  const f = fixture(t);
  let renames = 0;
  assert.throws(() => applyTypeboxRuntime(f.dir, f.recipeFile, { rename(from, to) {
    if (++renames === 2) throw Error("simulated sharing violation");
    fs.renameSync(from, to);
  } }), /simulated sharing violation/);
  assert.deepEqual(readTree(f.build), f.before);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ["build", "package.json"]);
});

test("a package junction never redirects replacement outside staging", t => {
  const f = fixture(t), external = path.join(f.dir, "external");
  fs.renameSync(f.root, external);
  fs.symlinkSync(external, f.root, "junction");
  assert.equal(applyTypeboxRuntime(f.dir, f.recipeFile).action, "unsupported");
  assert.deepEqual(readTree(path.join(external, "build")), f.before);
});

for (const published of [false, true]) test(`interrupted offline swap recovers (published=${published})`, t => {
  const f = fixture(t);
  const staged = path.join(f.root, ".cryoclaw-build-00000000-0000-4000-8000-000000000000");
  fs.mkdirSync(staged);
  for (const file of f.recipe.files) fs.writeFileSync(path.join(staged, file.path), file.content);
  fs.renameSync(f.build, `${staged}.original`);
  if (published) fs.renameSync(staged, f.build);
  assert.equal(applyTypeboxRuntime(f.dir, f.recipeFile).action, published ? "reused" : "compacted");
  assert.equal(treeDigest(readTree(f.build)), f.recipe.outputDigest);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ["build", "package.json"]);
});
