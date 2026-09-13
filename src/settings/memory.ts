/**
 * Settings IPC: Memory 工作区数据 + 内核 memory CLI 桥（概览/记忆/梦境分页的数据面）。
 *
 * - 列表 / 全文 / 追加：直接读写 workspace markdown（memory-workspace.ts）
 * - 召回测试 / 索引重建：spawn 内核 CLI（openclaw memory search|status --json），
 *   与真实对话共用同一条记忆召回管线
 * - 梦境删除：DREAMS.md 托管区文本手术（先备份 .bak）
 * - 插件修复：memory-core 置 enabled=true 并同步 plugins.allow
 */
import { ipcMain } from "electron";
import { spawn, execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { assertTrustedIpcSender } from "../ipc-sender-guard";
import {
  resolveNodeBin, resolveGatewayEntry, resolveGatewayCwd, resolveUserStateDir,
} from "../constants";
import { readUserConfig, writeUserConfig } from "../provider-config";
import { syncPluginAllowOnEnable } from "../kimi-config";
import {
  listWorkspaceMemory, readWorkspaceMemoryEntry, appendMemorySection, deleteDreamEntryFile,
  extractCliJson, buildMemoryCliArgs, coerceRecallPayload, coerceIndexStatus,
  parseDreamEntries, makeSnippet, DREAMS_FILE,
} from "../memory-workspace";

const MEMORY_CLI_TIMEOUT_SEARCH_MS = 90_000;
const MEMORY_CLI_TIMEOUT_INDEX_MS = 300_000;

function workspaceDir(): string {
  return path.join(resolveUserStateDir(), "workspace");
}

// 与 gateway-process spawn 保持一致的最小环境（asar 入口 + 统一状态目录）
function cliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_LENIENT_CONFIG: "1",
    OPENCLAW_STATE_DIR: resolveUserStateDir(),
  };
}

type CliOutcome = { ok: true; parsed: unknown } | { ok: false; message: string };

function runMemoryCli(args: string[], timeoutMs: number): Promise<CliOutcome> {
  return new Promise((resolve) => {
    const nodeBin = resolveNodeBin();
    const entry = resolveGatewayEntry();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(nodeBin, [entry, ...args], {
        cwd: resolveGatewayCwd(),
        env: cliEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err: any) {
      resolve({ ok: false, message: err?.message || String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    // memory CLI 可能再 spawn KNN 子进程；超时必须杀整棵树（Windows 上 child.kill
    // 只杀直接子进程，孙进程会变成孤儿继续占 CPU）
    const killTree = () => {
      if (child.pid == null) return;
      if (process.platform === "win32") {
        try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
      } else {
        try { child.kill("SIGKILL"); } catch {}
      }
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        killTree();
        resolve({ ok: false, message: "memory CLI timeout" });
      }
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, message: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = extractCliJson(stdout);
      if (parsed === null) {
        resolve({ ok: false, message: stderr.trim().split("\n").slice(-3).join(" ") || `memory CLI exited (${code})` });
        return;
      }
      resolve({ ok: true, parsed });
    });
  });
}

function data<T>(payload: T) { return { success: true, data: payload }; }
function fail(message: string) { return { success: false, message }; }

export function registerMemoryIpc(): void {
  // ── 记忆列表（MEMORY.md 章节 + memory/*.md 每日日志）──
  ipcMain.handle("memory:list", async (event) => {
    if (!assertTrustedIpcSender(event, "memory:list")) throw new Error("IPC sender not trusted");
    try {
      return data(listWorkspaceMemory(workspaceDir()));
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  // ── 单条记忆全文 ──
  ipcMain.handle("memory:read", async (event, params: { id?: string }) => {
    if (!assertTrustedIpcSender(event, "memory:read")) throw new Error("IPC sender not trusted");
    try {
      const entry = readWorkspaceMemoryEntry(workspaceDir(), String(params?.id ?? ""));
      if (!entry) return fail("entry not found");
      return data(entry);
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  // ── 新建记忆（追加到 MEMORY.md，自动备份）──
  ipcMain.handle("memory:append", async (event, params: { title?: string; content?: string }) => {
    if (!assertTrustedIpcSender(event, "memory:append")) throw new Error("IPC sender not trusted");
    try {
      appendMemorySection(workspaceDir(), String(params?.title ?? ""), String(params?.content ?? ""));
      return data({ appended: true });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  // ── 召回测试：与真实对话同一条检索管线 ──
  ipcMain.handle("memory:recall-test", async (event, params: { query?: string; maxResults?: number }) => {
    if (!assertTrustedIpcSender(event, "memory:recall-test")) throw new Error("IPC sender not trusted");
    const query = String(params?.query ?? "").trim();
    if (!query) return fail("empty query");
    const args = buildMemoryCliArgs("search", { query, maxResults: params?.maxResults });
    const outcome = await runMemoryCli(args, MEMORY_CLI_TIMEOUT_SEARCH_MS);
    if (!outcome.ok) return fail(outcome.message);
    return data(coerceRecallPayload(outcome.parsed));
  });

  // ── 索引重建 / 状态（memory plugin unavailable 的核心修复入口）──
  ipcMain.handle("memory:reindex", async (event) => {
    if (!assertTrustedIpcSender(event, "memory:reindex")) throw new Error("IPC sender not trusted");
    const args = buildMemoryCliArgs("reindex", {});
    const outcome = await runMemoryCli(args, MEMORY_CLI_TIMEOUT_INDEX_MS);
    if (!outcome.ok) return fail(outcome.message);
    return data(coerceIndexStatus(outcome.parsed));
  });

  // ── 梦境列表（主进程统一解析 DREAMS.md，index 语义与删除接口一致：0 = 最新）──
  ipcMain.handle("memory:list-dreams", async (event) => {
    if (!assertTrustedIpcSender(event, "memory:list-dreams")) throw new Error("IPC sender not trusted");
    try {
      let content = "";
      let found = false;
      try {
        content = fs.readFileSync(path.join(workspaceDir(), DREAMS_FILE), "utf-8");
        found = true;
      } catch {}
      if (!found) return data({ found: false, entries: [] });
      const entries = parseDreamEntries(content).map((e) => ({
        index: e.index,
        dateText: e.dateText,
        dateMs: e.dateMs,
        snippet: makeSnippet(e.body, 200),
        chars: e.body.length,
      }));
      return data({ found: true, entries });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  // ── 单条梦境全文 ──
  ipcMain.handle("memory:read-dream", async (event, params: { index?: number }) => {
    if (!assertTrustedIpcSender(event, "memory:read-dream")) throw new Error("IPC sender not trusted");
    try {
      const content = fs.readFileSync(path.join(workspaceDir(), DREAMS_FILE), "utf-8");
      const entry = parseDreamEntries(content)[Number(params?.index)];
      if (!entry) return fail("dream entry not found");
      return data({ dateText: entry.dateText, body: entry.body });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  // ── 删除单条梦境（DREAMS.md 托管区手术 + .bak 备份）──
  ipcMain.handle("memory:delete-dream", async (event, params: { index?: number }) => {
    if (!assertTrustedIpcSender(event, "memory:delete-dream")) throw new Error("IPC sender not trusted");
    const index = Number(params?.index);
    if (!Number.isInteger(index) || index < 0) return fail("invalid index");
    const ok = deleteDreamEntryFile(path.join(workspaceDir(), DREAMS_FILE), index);
    return ok ? data({ deleted: true }) : fail("dream entry not found");
  });

  // ── 修复记忆插件（memory-core 重新启用 + allow 同步）──
  ipcMain.handle("memory:repair-plugin", async (event) => {
    if (!assertTrustedIpcSender(event, "memory:repair-plugin")) throw new Error("IPC sender not trusted");
    try {
      const config = readUserConfig();
      if (!config) return fail("config unavailable");
      config.plugins ??= {};
      config.plugins.entries ??= {};
      const entry = config.plugins.entries["memory-core"];
      if (typeof entry !== "object" || entry === null) {
        config.plugins.entries["memory-core"] = { enabled: true };
      } else {
        entry.enabled = true;
      }
      syncPluginAllowOnEnable(config, "memory-core");
      writeUserConfig(config);
      return data({ enabled: true });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });
}
