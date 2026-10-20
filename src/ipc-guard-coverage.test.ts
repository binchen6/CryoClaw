// ipc-guard-coverage.test.ts — 安全契约：src/ 下每一个 ipcMain.handle/on 通道都必须
// 校验 sender 可信。判定方式（纯源码静态分析，无 Electron 运行时）：
//   - 通道处理器体内（本次注册到下一条注册之间）直调 assertTrustedIpcSender；或
//   - 调用本文件内某个「函数体内含 assertTrustedIpcSender」的 wrapper（如 git-ipc 的
//     guardGitOp 公共守卫链）。
// 新增通道忘了校验时此测试立即点名文件与通道，避免安全基线依赖评审纪律。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// 产物为 CJS（tsconfig.test.json），__dirname = .test-dist/，上一级即仓库根
const SRC_DIR = join(__dirname, "..", "src");
const GUARD = "assertTrustedIpcSender";
const REGISTRATION = /ipcMain\.(?:handle|on)\(\s*["'`]([^"'`]+)["'`]/g;
const FUNCTION_DEF = /(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\()/g;

function listSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) acc = listSources(full, acc);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

test("every ipcMain channel validates the IPC sender", () => {
  const offenders: string[] = [];
  let channels = 0;
  for (const file of listSources(SRC_DIR)) {
    const src = readFileSync(file, "utf8");
    const registrations = [...src.matchAll(REGISTRATION)];
    if (registrations.length === 0) continue;
    // 本文件内含 guard 的 wrapper 函数名集合
    const wrappers = new Set<string>();
    for (const m of src.matchAll(FUNCTION_DEF)) {
      const name = m[1] ?? m[2];
      if (name && src.slice(m.index, m.index + 4000).includes(GUARD)) wrappers.add(name);
    }
    for (let i = 0; i < registrations.length; i++) {
      channels++;
      // 处理器窗口：到下一条注册或所在 register*() 函数的收尾（顶格 `}`）为止，
      // 避免文件末尾的末条注册把下文其他函数体内的 guard 误算进自己窗口
      const start = registrations[i].index;
      const nextRegistration = i + 1 < registrations.length ? registrations[i + 1].index : src.length;
      const functionEnd = src.indexOf("\n}\n", start);
      const end = Math.min(nextRegistration, functionEnd === -1 ? src.length : functionEnd);
      const body = src.slice(start, end);
      const guarded = body.includes(GUARD) || [...wrappers].some((w) => body.includes(w));
      if (!guarded) offenders.push(`${file} :: ${registrations[i][1]}`);
    }
  }
  assert.ok(channels > 100, `通道基数异常（${channels}），源扫描可能失效`);
  assert.deepEqual(offenders, [], `以下 IPC 通道缺少 sender 校验：\n${offenders.join("\n")}`);
});
