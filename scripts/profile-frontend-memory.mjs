// Targeted Node/V8 retention probe, not an Electron renderer RSS benchmark.
// Run: node --expose-gc scripts/profile-frontend-memory.mjs current
//      node --expose-gc scripts/profile-frontend-memory.mjs baseline [git-ref]
// Compiles only Markdown + its imports into an owned temporary directory,
// never the shared test/build output; removes that directory on completion.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const variant = process.argv[2] ?? "current";
if (!["current", "baseline"].includes(variant) || typeof globalThis.gc !== "function") {
  throw new Error("Use node --expose-gc scripts/profile-frontend-memory.mjs current|baseline [git-ref]");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const parent = resolve(root, "chat-ui/ui/.cache");
mkdirSync(parent, { recursive: true });
const owned = mkdtempSync(join(parent, "frontend-memory-"));
try {
  const config = join(owned, "tsconfig.json");
  const dist = join(owned, "dist");
  writeFileSync(config, JSON.stringify({
    extends: join(root, "chat-ui/tsconfig.test.json"),
    compilerOptions: { outDir: dist },
    include: [join(root, "chat-ui/ui/src/ui/markdown.ts")],
  }));
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", config], { cwd: root, stdio: "pipe" });
  writeFileSync(join(dist, "package.json"), '{"type":"module"}');
  const output = pathToFileURL(join(dist, "ui/src/ui/") + "/");
  if (variant === "baseline") {
    let source = execFileSync("git", ["show", `${process.argv[3] ?? "HEAD"}:chat-ui/ui/src/ui/markdown.ts`], { cwd: root, encoding: "utf8" });
    if (source.includes("export function markdownCacheStats")) throw new Error("Choose a baseline git ref before the cache budget change");
    source += "\nexport function markdownCacheStats() { return { entries: markdownCache.size, retainedCodeUnits: [...markdownCache].reduce((n, [k,v]) => n+k.length+v.length, 0) }; }\n";
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true },
    });
    writeFileSync(new URL("markdown-baseline.js", output), compiled.outputText);
  }
  // Match markdown.test.ts: isolate retention policy from a DOM implementation.
  globalThis.window = { document: { nodeType: 9, currentScript: null, createElement: () => ({}) }, Element: class {} };
  const markdown = await import(new URL(variant === "baseline" ? "markdown-baseline.js" : "markdown.js", output));
  markdown.toSanitizedMarkdownHtml("warmup", { bypassCache: true });
  for (let i = 0; i < 3; i++) globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200; i++) markdown.toSanitizedMarkdownHtml(`${i}:` + "&".repeat(49_990));
  for (let i = 0; i < 3; i++) globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  console.log(JSON.stringify({ variant, node: process.version, fixture: "200 distinct ~50k inputs, HTML escaping expansion", ...markdown.markdownCacheStats(), heapBeforeBytes: before, heapAfterBytes: after, retainedHeapDeltaBytes: after - before }, null, 2));
} finally {
  if (resolve(owned).startsWith(parent + "/") || resolve(owned).startsWith(parent + "\\")) rmSync(owned, { recursive: true, force: true });
  else throw new Error("Refuse to remove an unowned memory probe directory");
}
