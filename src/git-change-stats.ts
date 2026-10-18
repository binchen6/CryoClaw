// 本轮改动文件的 git 行数统计 —— 主进程纯逻辑模块（不依赖 electron，可独立单测）。
//
// 场景：聊天页输入框上方的「本轮改动」胶囊要显示 +新增/−删除行数。
// 渲染层只知道工具参数里的路径（可能是仓库相对、带 Windows 反斜杠、或绝对路径），
// 本模块负责：
//   1. `git rev-parse --show-toplevel` 找 cwd 所属仓库根；
//   2. `git status --porcelain=v2 -z` 列出工作区改动（含未跟踪 / 重命名）；
//   3. 把渲染层路径按「绝对路径归一 / 最长后缀」匹配到仓库改动项；
//   4. tracked 文件一次 `git diff HEAD --numstat -z` 取全部增删行数；
//      未跟踪文件按读文件行数计新增（单文件大小上限 + NUL 二进制嗅探）。
//
// 安全边界：trusted sender 与 cwd 白名单在 git-ipc.ts 的 guardGitOp；
// 本模块只做入参数量/长度上限。渲染层原始字符串不进 argv —— `--` 之后只放
// 从 git status 解析出的仓库相对路径，因此不存在 pathspec 注入面。
// 失败一律返回结构化错误，由 IPC 层翻译成渲染层可降级的错误码。

import * as fs from "fs";
import type { FileHandle } from "fs/promises";
import * as path from "path";
import { isNotARepoError, parsePorcelainV2Status, type GitStatusEntry } from "./git-parse";
import type { GitRunResult } from "./git-run";

/** 单次请求最多统计的文件数（超出截断并标记 truncated） */
export const MAX_CHANGE_STAT_PATHS = 200;
/** 单个入参路径长度上限（含绝对路径，给 Windows 长路径留余量） */
export const MAX_CHANGE_STAT_PATH_CHARS = 1024;
/** `git diff --numstat` 路径参数总长度上限（Windows CreateProcess 命令行 32767 上限的保守值） */
export const MAX_DIFF_ARGV_CHARS = 24_000;
/** 未跟踪文件单文件读取上限：超出按二进制处理（不显示行数，避免整文件读入主进程） */
export const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
/** 单次请求未跟踪文件读取总预算：超出停止统计（结果标记 truncated，渲染层退回文件数） */
export const MAX_UNTRACKED_TOTAL_BYTES = 8 * 1024 * 1024;
/** git 自身判定二进制的口径：前 8000 字节出现 NUL 即视为二进制 */
const BINARY_SNIFF_BYTES = 8_000;
/** 恶意/异常渲染层一次塞入过多路径时直接拒绝（正常情况下远小于此） */
const MAX_RAW_PATHS = MAX_CHANGE_STAT_PATHS * 5;
const STDERR_PREVIEW = 4_000;

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

export type GitChangeStat = {
  /** 渲染层传入的原始路径（按此键与「本轮改动」列表对应） */
  path: string;
  additions: number;
  deletions: number;
  /** 二进制文件：增删行数无意义，UI 不显示数字 */
  binary?: boolean;
};

export type GitChangeStatsData = { stats: GitChangeStat[]; truncated?: boolean };

export type GitChangeStatsOutcome =
  | { ok: true; data: GitChangeStatsData }
  | { ok: false; error: "invalid-input" | "not-a-repo" | "git-error"; message?: string };

/** 注入的 git runner（IPC 层绑定 cwd/超时/maxBuffer；测试注入假数据） */
export type ChangeStatsRunGit = (args: string[]) => Promise<GitRunResult>;

export type FileLineCount = { additions: number; binary: boolean; bytes: number };

/** 注入的未跟踪文件读取器（默认实现见 readUntrackedInsideRepo） */
export type ChangeStatsReadFile = (
  absolutePath: string,
  repoRoot: string,
) => Promise<FileLineCount | null>;

export type ChangeStatsDeps = {
  runGit: ChangeStatsRunGit;
  readUntrackedFile?: ChangeStatsReadFile;
  maxDiffArgvChars?: number;
  maxUntrackedTotalBytes?: number;
};

// ── 入参校验 ─────────────────────────────────────────────────────────

/**
 * 校验路径数组：去空、去重、限长、限数量。非法返回 null（IPC 层回 invalid-input）；
 * 超过 MAX_CHANGE_STAT_PATHS 的部分丢弃并标记 truncated。
 */
export function sanitizeChangeStatPaths(
  raw: unknown,
): { paths: string[]; truncated: boolean } | null {
  if (!Array.isArray(raw) || raw.length > MAX_RAW_PATHS) return null;
  const paths: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const value = item.trim();
    if (!value) continue;
    if (value.length > MAX_CHANGE_STAT_PATH_CHARS) return null;
    if (/[\0\r\n]/.test(value)) return null;
    if (seen.has(value)) continue;
    if (paths.length >= MAX_CHANGE_STAT_PATHS) {
      truncated = true;
      continue;
    }
    seen.add(value);
    paths.push(value);
  }
  return { paths, truncated };
}

// ── porcelain v2 改动项与路径匹配 ────────────────────────────────────

export type RepoChange = {
  kind: GitStatusEntry["kind"];
  /** 仓库根相对路径（forward slash） */
  repoPath: string;
  /** rename/copy 的源路径（仓库根相对） */
  origPath?: string;
};

/** 从 status 条目提取改动项（ignored 不算改动） */
export function collectRepoChanges(entries: readonly GitStatusEntry[]): RepoChange[] {
  const changes: RepoChange[] = [];
  for (const entry of entries) {
    if (entry.kind === "ignored" || !entry.path) continue;
    changes.push({
      kind: entry.kind,
      repoPath: entry.path,
      ...(entry.origPath ? { origPath: entry.origPath } : {}),
    });
  }
  return changes;
}

function toSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function foldCase(value: string): string {
  return CASE_INSENSITIVE_FS ? value.toLowerCase() : value;
}

function normalizeRel(value: string): string {
  return foldCase(toSlashes(value).replace(/^\.\//, ""));
}

/** 相对路径 candidates 的归一化形式（不修边：空/越界相对路径不加入） */
function relativeCandidate(base: string, absolutePath: string): string | null {
  const relative = toSlashes(path.relative(base, absolutePath)).replace(/^\.\//, "");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    return null;
  }
  return foldCase(relative);
}

/**
 * 把渲染层路径匹配到仓库改动项。按「绝对路径归一 / 最长后缀」两级匹配：
 * - 绝对路径先尝试相对 repoRoot / cwd 的相对形式（精确命中）；
 * - 其余走后缀匹配（`src/a.ts` ↔ `C:/repo/src/a.ts`，或 cwd 是子目录时
 *   `src/a.ts` ↔ `packages/app/src/a.ts`），取匹配后缀最长的改动项；
 * - rename 改动同时接受源路径。
 * 找不到返回 null（渲染层据此退回文件数）。
 */
export function matchChangePath(
  inputPath: string,
  cwd: string,
  repoRoot: string,
  changes: readonly RepoChange[],
): RepoChange | null {
  const raw = inputPath.trim();
  if (!raw) return null;

  const candidates = new Set<string>();
  candidates.add(normalizeRel(raw));
  if (path.isAbsolute(raw)) {
    const absolutePath = path.resolve(raw);
    candidates.add(foldCase(toSlashes(absolutePath)));
    const fromRoot = relativeCandidate(repoRoot, absolutePath);
    if (fromRoot) candidates.add(fromRoot);
    const fromCwd = relativeCandidate(cwd, absolutePath);
    if (fromCwd) candidates.add(fromCwd);
  }

  let best: { change: RepoChange; score: number } | null = null;
  for (const change of changes) {
    const names =
      change.origPath && change.origPath !== change.repoPath
        ? [change.repoPath, change.origPath]
        : [change.repoPath];
    for (const name of names) {
      const repoPath = foldCase(toSlashes(name).replace(/^\.\//, ""));
      for (const candidate of candidates) {
        if (!candidate) continue;
        const score = suffixScore(candidate, repoPath);
        if (score > 0 && (!best || score > best.score)) {
          best = { change, score };
        }
      }
    }
  }
  return best?.change ?? null;
}

/** 精确匹配得分远高于后缀匹配，保证「同名不同目录」时精确路径优先 */
const EXACT_MATCH_BONUS = 1_000_000;

function suffixScore(candidate: string, repoPath: string): number {
  if (candidate === repoPath) return repoPath.length + EXACT_MATCH_BONUS;
  // 输入比仓库路径短（路径写的是子目录相对 / 只写了尾部片段）
  if (repoPath.endsWith(`/${candidate}`)) return candidate.length;
  // 输入比仓库路径长（绝对路径 / 带上层目录名）
  if (candidate.endsWith(`/${repoPath}`)) return repoPath.length;
  return 0;
}

// ── --numstat -z 解析 ────────────────────────────────────────────────

export type NumstatRecord = {
  /** 目标路径（rename 时为新路径；非 rename 为文件路径） */
  path: string;
  /** rename 的源路径（仅 -z 的双路径记录） */
  origPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
};

/**
 * 解析 `git diff [HEAD] --numstat -z` 输出。
 * 普通记录：`<add>\t<del>\t<path>\0`；
 * rename 记录（两侧路径都在 pathspec 内时）：`<add>\t<del>\t\0<old>\0<new>\0`；
 * 二进制文件的 add/del 为 `-`。
 */
export function parseNumstatZ(stdout: string): NumstatRecord[] {
  const segments = stdout.split("\0");
  const records: NumstatRecord[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(segment);
    if (!match) continue;
    const binary = match[1] === "-" || match[2] === "-";
    const additions = match[1] === "-" ? 0 : Number(match[1]);
    const deletions = match[2] === "-" ? 0 : Number(match[2]);
    const inlinePath = match[3];
    if (inlinePath) {
      records.push({ path: inlinePath, additions, deletions, binary });
      continue;
    }
    // rename 双路径：源路径、目标路径各占一个 NUL 段
    const origPath = segments[i + 1];
    const newPath = segments[i + 2];
    if (origPath && newPath) {
      records.push({ path: newPath, origPath, additions, deletions, binary });
      i += 2;
    }
  }
  return records;
}

/**
 * 限制 diff 路径参数总长度（Windows 命令行长度上限）。超出部分丢弃并标记 truncated；
 * stats 结果会标记 truncated，渲染层整体退回文件数（不做半截统计）。
 */
export function clampDiffPaths(
  paths: readonly string[],
  maxChars = MAX_DIFF_ARGV_CHARS,
): { paths: string[]; truncated: boolean } {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of paths) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  const out: string[] = [];
  let used = 0;
  for (const value of unique) {
    const cost = value.length + 1;
    if (used + cost > maxChars) return { paths: out, truncated: true };
    out.push(value);
    used += cost;
  }
  return { paths: out, truncated: false };
}

// ── 未跟踪文件行数 ───────────────────────────────────────────────────

/**
 * 读未跟踪文本文件的行数（按「新增行」计）。
 * - 前 8000 字节含 NUL → 二进制（行数无意义）；
 * - 超过 maxBytes → 按二进制处理（完整行数需要读全文件，收益不成比例）；
 * - 读失败 / 非普通文件 → null（调用方跳过该文件）。
 */
export async function countUntrackedFileLines(
  filePath: string,
  maxBytes = MAX_UNTRACKED_FILE_BYTES,
): Promise<FileLineCount | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const limit = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    const bytes = buffer.subarray(0, bytesRead);
    const sniff = bytes.subarray(0, Math.min(bytes.length, BINARY_SNIFF_BYTES));
    if (sniff.includes(0)) return { additions: 0, binary: true, bytes: bytesRead };
    if (stat.size > maxBytes) return { additions: 0, binary: true, bytes: bytesRead };
    let additions = 0;
    for (const byte of bytes) {
      if (byte === 0x0a) additions += 1;
    }
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) additions += 1;
    return { additions, binary: false, bytes: bytesRead };
  } catch {
    return null;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

function normalizeForContainment(value: string): string {
  const resolved = path.resolve(value).replace(/\\/g, "/");
  return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

function isInsideDir(target: string, root: string): boolean {
  const normalizedTarget = normalizeForContainment(target);
  const normalizedRoot = normalizeForContainment(root);
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(prefix);
}

/** 默认读取器：realpath 复核防符号链接逃逸出仓库（工作区由 agent 可写） */
async function readUntrackedInsideRepo(
  absolutePath: string,
  repoRoot: string,
): Promise<FileLineCount | null> {
  let realPath: string;
  try {
    realPath = await fs.promises.realpath(absolutePath);
  } catch {
    return null;
  }
  if (!isInsideDir(realPath, repoRoot)) return null;
  return countUntrackedFileLines(realPath);
}

// ── 主流程 ───────────────────────────────────────────────────────────

function classifyGitFailure(result: GitRunResult): Extract<GitChangeStatsOutcome, { ok: false }> {
  if (isNotARepoError(result.stderr)) return { ok: false, error: "not-a-repo" };
  const message = result.stderr.trim().slice(0, STDERR_PREVIEW) || `git exited with code ${result.code}`;
  return { ok: false, error: "git-error", message };
}

const EMPTY_DIE_RE = /ambiguous argument 'HEAD'|unknown revision|bad revision/i;

type NumstatLoad =
  | { ok: true; records: NumstatRecord[]; truncated: boolean }
  | { ok: false; error: "not-a-repo" | "git-error"; message?: string };

async function loadNumstat(
  changes: readonly RepoChange[],
  deps: ChangeStatsDeps,
): Promise<NumstatLoad> {
  const allPaths = [
    ...changes.map((change) => change.repoPath),
    ...changes.map((change) => change.origPath ?? ""),
  ];
  const { paths, truncated } = clampDiffPaths(allPaths, deps.maxDiffArgvChars);
  if (paths.length === 0) return { ok: true, records: [], truncated };

  let result = await deps.runGit(["diff", "HEAD", "--numstat", "-z", "--", ...paths]);
  // 空仓库（unborn HEAD）没有 HEAD 可比：退回 --cached 统计已入索引的改动
  if (result.code !== 0 && EMPTY_DIE_RE.test(result.stderr)) {
    result = await deps.runGit(["diff", "--cached", "--numstat", "-z", "--", ...paths]);
  }
  if (result.code !== 0) {
    const failure = classifyGitFailure(result);
    return failure.error === "not-a-repo"
      ? { ok: false, error: "not-a-repo" }
      : { ok: false, error: "git-error", message: failure.message };
  }
  return { ok: true, records: parseNumstatZ(result.stdout), truncated: truncated || result.truncated };
}

/**
 * 计算 paths[] 中每个路径相对 HEAD 的增删行数。
 * 返回的 stats 只包含能匹配到仓库改动的路径；stats 缺失 = 该文件行数不可用
 * （渲染层据此整体退回「新增/删除文件数」）。
 */
export async function computeGitChangeStats(
  cwd: string,
  rawPaths: unknown,
  deps: ChangeStatsDeps,
): Promise<GitChangeStatsOutcome> {
  const sanitized = sanitizeChangeStatPaths(rawPaths);
  if (!sanitized) return { ok: false, error: "invalid-input" };
  if (sanitized.paths.length === 0) return { ok: true, data: { stats: [] } };

  const rootResult = await deps.runGit(["rev-parse", "--show-toplevel"]);
  if (rootResult.code !== 0) return classifyGitFailure(rootResult);
  const rootLine = rootResult.stdout.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  if (!rootLine) {
    return { ok: false, error: "git-error", message: "无法解析仓库根路径" };
  }
  const repoRoot = path.resolve(rootLine);

  const statusResult = await deps.runGit(["status", "--porcelain=v2", "-z"]);
  if (statusResult.code !== 0) return classifyGitFailure(statusResult);
  const statusTruncated = statusResult.truncated;
  const changes = collectRepoChanges(parsePorcelainV2Status(statusResult.stdout).entries);

  const matched: Array<{ inputPath: string; change: RepoChange }> = [];
  for (const inputPath of sanitized.paths) {
    const change = matchChangePath(inputPath, cwd, repoRoot, changes);
    if (change) matched.push({ inputPath, change });
  }
  if (matched.length === 0) {
    return {
      ok: true,
      data: {
        stats: [],
        ...(sanitized.truncated || statusTruncated ? { truncated: true } : {}),
      },
    };
  }

  const trackedChanges = matched
    .filter((entry) => entry.change.kind !== "untracked")
    .map((entry) => entry.change);
  const numstat = await loadNumstat(trackedChanges, deps);
  if (!numstat.ok) {
    return numstat.error === "not-a-repo"
      ? { ok: false, error: "not-a-repo" }
      : { ok: false, error: "git-error", message: numstat.message };
  }

  const byPath = new Map<string, NumstatRecord>();
  const byOrigPath = new Map<string, NumstatRecord>();
  for (const record of numstat.records) {
    byPath.set(record.path, record);
    if (record.origPath) byOrigPath.set(record.origPath, record);
  }

  // 未跟踪文件独立按文件行数计新增（不进 git diff）
  const readUntrackedFile = deps.readUntrackedFile ?? readUntrackedInsideRepo;
  let untrackedBudget = deps.maxUntrackedTotalBytes ?? MAX_UNTRACKED_TOTAL_BYTES;
  let untrackedTruncated = false;
  const untrackedStats = new Map<string, FileLineCount>();
  let repoRootReal = repoRoot;
  try {
    repoRootReal = await fs.promises.realpath(repoRoot);
  } catch {
    repoRootReal = repoRoot;
  }
  for (const entry of matched) {
    if (entry.change.kind !== "untracked") continue;
    if (untrackedBudget <= 0) {
      untrackedTruncated = true;
      break;
    }
    const counted = await readUntrackedFile(
      path.join(repoRoot, entry.change.repoPath),
      repoRootReal,
    );
    if (!counted) continue;
    untrackedBudget -= counted.bytes;
    untrackedStats.set(entry.change.repoPath, counted);
  }

  const stats: GitChangeStat[] = [];
  for (const { inputPath, change } of matched) {
    if (change.kind === "untracked") {
      const counted = untrackedStats.get(change.repoPath);
      if (!counted) continue;
      stats.push({
        path: inputPath,
        additions: counted.additions,
        deletions: 0,
        ...(counted.binary ? { binary: true } : {}),
      });
      continue;
    }
    const primary = byPath.get(change.repoPath);
    const originalRecord = change.origPath
      ? (byOrigPath.get(change.origPath) ?? byPath.get(change.origPath))
      : undefined;
    // rename 被 git 识别为单条记录时 orig 与 primary 是同一条，不能重复累加；
    // 未被识别为 rename 时 git 输出旧路径删除 + 新路径新增两条，合计才是真实规模。
    const original = originalRecord && originalRecord !== primary ? originalRecord : undefined;
    if (!primary && !original) continue;
    const additions = (primary?.additions ?? 0) + (original?.additions ?? 0);
    const deletions = (primary?.deletions ?? 0) + (original?.deletions ?? 0);
    const binary = Boolean(primary?.binary || original?.binary);
    stats.push({
      path: inputPath,
      additions,
      deletions,
      ...(binary ? { binary: true } : {}),
    });
  }

  const truncated = sanitized.truncated || statusTruncated || numstat.truncated || untrackedTruncated;
  return { ok: true, data: { stats, ...(truncated ? { truncated: true } : {}) } };
}
