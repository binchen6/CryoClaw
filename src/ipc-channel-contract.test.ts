// ipc-channel-contract.test.ts — 通道对齐契约（纯源码静态分析，无 Electron 运行时）：
//   ① preload invoke/send 的每条通道必须在主进程有注册——字面量注册、模板前缀注册
//     （如 `settings:openai-proxy-${action}`）或本文件 helper 调用点注册
//     （如 git-ipc 的 registerMutation("git:stage", …)）；
//   ② preload on 监听的每条事件通道必须有主进程 .send 来源；
//   ③ 全部调用与事件通道必须出现在 docs/ipc-api.md（锁死第 17 轮的文档对齐成果）。
// CJS 产物（tsconfig.test.json），__dirname = .test-dist/。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const SRC_DIR = join(ROOT, "src");

const CHANNEL = String.raw`["'\`]([^"'\`]+)["'\`]`;
const PRELOAD_CALL = new RegExp(String.raw`ipcRenderer\.(?:invoke|send)\(\s*` + CHANNEL, "g");
const PRELOAD_ON = new RegExp(String.raw`ipcRenderer\.on\(\s*` + CHANNEL, "g");
const MAIN_REGISTER = new RegExp(String.raw`ipcMain\.(?:handle|on)\(\s*` + CHANNEL, "g");
// 模板字面量注册：取 `${` 前的字面量前缀做前缀匹配——含两种形态：
//   ipcMain.handle(`prefix-${x}`, …) 直接注册；const ch = `prefix-${x}` 先赋值再注册
const MAIN_REGISTER_TEMPLATE = /ipcMain\.(?:handle|on)\(\s*`([^`$]+)\$\{/g;
const TEMPLATE_CHANNEL_CONST = /(?:const|let)\s+\w+\s*=\s*`([a-z][a-z0-9-]*(?::[a-z0-9-]+)+-[^`$]*)\$\{/g;
const MAIN_SEND = new RegExp(String.raw`\.send\(\s*` + CHANNEL, "g");
const FN_DEF = /(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\()/g;
const MAIN_REGISTER_DYNAMIC = /ipcMain\.(?:handle|on)\(\s*[a-zA-Z_]/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) acc = walk(full, acc);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

test("preload ↔ main channel alignment and docs coverage", () => {
  const preload = readFileSync(join(SRC_DIR, "preload.ts"), "utf8");
  const invoked = new Set([...preload.matchAll(PRELOAD_CALL)].map((m) => m[1]));
  const listened = new Set([...preload.matchAll(PRELOAD_ON)].map((m) => m[1]));

  const registered = new Set<string>();
  const templatePrefixes: string[] = [];
  const sentFromMain = new Set<string>();
  for (const file of walk(SRC_DIR)) {
    // preload.ts 也在 src/ 下：其 ipcRenderer.* 是渲染层方向，不得计入主进程集合
    if (file.endsWith("preload.ts")) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(MAIN_REGISTER)) registered.add(m[1]);
    for (const m of src.matchAll(MAIN_REGISTER_TEMPLATE)) templatePrefixes.push(m[1]);
    for (const m of src.matchAll(TEMPLATE_CHANNEL_CONST)) templatePrefixes.push(m[1]);
    for (const m of src.matchAll(MAIN_SEND)) sentFromMain.add(m[1]);
    // 本文件 helper：函数体内含动态通道 ipcMain 注册；其调用点的字面量首参即注册通道
    for (const def of src.matchAll(FN_DEF)) {
      const name = def[1] ?? def[2];
      if (!name) continue;
      if (!MAIN_REGISTER_DYNAMIC.test(src.slice(def.index, def.index + 4000))) continue;
      const callRe = new RegExp(String.raw`\b${name}\(\s*` + CHANNEL, "g");
      for (const call of src.matchAll(callRe)) registered.add(call[1]);
    }
  }

  // 防呆：扫描面失效（如 preload 大改版）时立刻失败，而不是静默放行
  assert.ok(invoked.size > 100, `preload 通道基数异常（${invoked.size}）`);
  assert.ok(registered.size > 100, `主进程注册通道基数异常（${registered.size}）`);

  const unregistered = [...invoked].filter(
    (c) => !registered.has(c) && !templatePrefixes.some((p) => c.startsWith(p)),
  );
  assert.deepEqual(unregistered, [], `preload 调用但主进程未注册：\n${unregistered.join("\n")}`);

  const unsent = [...listened].filter((c) => !sentFromMain.has(c));
  assert.deepEqual(unsent, [], `preload 监听但主进程从未发送：\n${unsent.join("\n")}`);

  const doc = readFileSync(join(ROOT, "docs", "ipc-api.md"), "utf8");
  const undocumented = [...invoked, ...listened].filter((c) => !doc.includes(`\`${c}\``));
  assert.deepEqual(undocumented, [], `未写入 docs/ipc-api.md：\n${undocumented.join("\n")}`);
});
