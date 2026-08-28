// git 输出解析纯函数模块 —— 与 Electron/IPC 解耦，可独立单测。
// 覆盖两种输出：
//   1. `git status --porcelain=v2 -z -b`（机器格式，NUL 分隔，路径不做 C 引用转义）
//   2. unified diff（`git diff [--cached] [-- <path>]`，路径可能 C 引用八进制转义，如中文）
// 解析只做容错式提取（未知行一律跳过），永不抛异常。

// ── porcelain v2 status ─────────────────────────────────────────────

export type GitBranchInfo = {
  /** 分支名；detached 时为 "(detached)"；空仓库（initial）为 null */
  head: string | null;
  /** HEAD commit oid；空仓库为 null */
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
};

export type GitStatusKind = "tracked" | "renamed" | "unmerged" | "untracked" | "ignored";

export type GitStatusEntry = {
  kind: GitStatusKind;
  /** 相对仓库根的路径（-z 模式下为原文，无转义） */
  path: string;
  /** rename/copy 的源路径（仅 kind === "renamed" 时存在） */
  origPath?: string;
  /** XY 的 X：index（staged）状态字母；未变更为 "."；untracked/ignored 同 kind 字符 */
  index: string;
  /** XY 的 Y：worktree（unstaged）状态字母 */
  worktree: string;
};

export type GitStatusResult = {
  branch: GitBranchInfo;
  entries: GitStatusEntry[];
};

/** staged 组：tracked/renamed 且 index 字母非 "." */
export function isStagedEntry(e: GitStatusEntry): boolean {
  return (e.kind === "tracked" || e.kind === "renamed") && e.index !== "." && e.index !== " ";
}

/** unstaged 组：tracked/renamed 且 worktree 字母非 "."；unmerged 归入 unstaged */
export function isUnstagedEntry(e: GitStatusEntry): boolean {
  if (e.kind === "unmerged") return true;
  return (e.kind === "tracked" || e.kind === "renamed") && e.worktree !== "." && e.worktree !== " ";
}

function emptyBranch(): GitBranchInfo {
  return { head: null, oid: null, upstream: null, ahead: 0, behind: 0 };
}

// 前 maxSplit 个空格各切一刀，余下整段（含空格）作为最后一个元素。
// （String.split(sep, limit) 会丢弃余段，含空格的路径会被截断，不能用。）
function splitHeadSegments(segment: string, maxSplit: number): string[] {
  const parts: string[] = [];
  let rest = segment;
  for (let n = 0; n < maxSplit; n++) {
    const idx = rest.indexOf(" ");
    if (idx === -1) break;
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  parts.push(rest);
  return parts;
}

// 解析 `1`（ordinary）/ `2`（rename/copy）条目的元数据段。
// format: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
//         `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`（-z 时 origPath 在下一个 NUL 段）
// 字段数不固定（ordinary 8 列、rename 9 列），用列数切分后余下整段为 path。
function parseTrackedEntry(segment: string): Omit<GitStatusEntry, "origPath"> | null {
  const kind: GitStatusKind = segment.startsWith("2 ") ? "renamed" : "tracked";
  const maxSplit = kind === "renamed" ? 9 : 8;
  const parts = splitHeadSegments(segment, maxSplit);
  if (parts.length < maxSplit + 1) return null;
  const xy = parts[1];
  return {
    kind,
    index: xy[0] ?? ".",
    worktree: xy[1] ?? ".",
    path: parts[maxSplit],
  };
}

// `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`（10 列元数据）
function parseUnmergedEntry(segment: string): GitStatusEntry | null {
  const parts = splitHeadSegments(segment, 10);
  if (parts.length < 11) return null;
  const xy = parts[1];
  return { kind: "unmerged", index: xy[0] ?? ".", worktree: xy[1] ?? ".", path: parts[10] };
}

/**
 * 解析 `git status --porcelain=v2 -z -b` 输出。
 * -z 语义：条目以 NUL 分隔、路径不做引用转义；rename 条目为
 * `2 ... <toPath>\0<fromPath>\0`（两个 NUL 段，目标在前源在后，字段顺序与无 -z 相反）。
 */
export function parsePorcelainV2Status(output: string): GitStatusResult {
  const branch = emptyBranch();
  const entries: GitStatusEntry[] = [];
  const segments = output.split("\0");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    if (seg.startsWith("# ")) {
      // branch header 行（-z 下仍是 \n 分隔的多行，含在首个 NUL 段里）
      for (const line of seg.split("\n")) {
        if (line.startsWith("# branch.oid ")) {
          const oid = line.slice("# branch.oid ".length).trim();
          branch.oid = oid && oid !== "(initial)" ? oid : null;
        } else if (line.startsWith("# branch.head ")) {
          branch.head = line.slice("# branch.head ".length).trim() || null;
        } else if (line.startsWith("# branch.upstream ")) {
          branch.upstream = line.slice("# branch.upstream ".length).trim() || null;
        } else if (line.startsWith("# branch.ab ")) {
          const m = line.slice("# branch.ab ".length).match(/\+(\d+)\s+-(\d+)/);
          if (m) {
            branch.ahead = Number(m[1]);
            branch.behind = Number(m[2]);
          }
        }
      }
      continue;
    }
    if (seg.startsWith("1 ") || seg.startsWith("2 ")) {
      const parsed = parseTrackedEntry(seg);
      if (!parsed) continue;
      const entry: GitStatusEntry = { ...parsed };
      if (entry.kind === "renamed") {
        // porcelain v2 -z 格式保证 rename 条目的源路径占下一个 NUL 段，无条件消费
        const orig = segments[i + 1];
        if (orig != null && orig !== "") {
          entry.origPath = orig;
          i += 1;
        }
      }
      entries.push(entry);
      continue;
    }
    if (seg.startsWith("u ")) {
      const parsed = parseUnmergedEntry(seg);
      if (parsed) entries.push(parsed);
      continue;
    }
    if (seg.startsWith("? ")) {
      entries.push({ kind: "untracked", index: "?", worktree: "?", path: seg.slice(2) });
      continue;
    }
    if (seg.startsWith("! ")) {
      entries.push({ kind: "ignored", index: "!", worktree: "!", path: seg.slice(2) });
      continue;
    }
  }
  return { branch, entries };
}

// ── C 引用路径反转义 ─────────────────────────────────────────────────

/**
 * git 对含非 ASCII/特殊字符的路径做 C 风格引用（`"a/\303\244.ts"`）。
 * 仅当字符串以 `"` 开头时才按引用解析；八进制转义按字节收集后统一 UTF-8 解码，
 * 保证多字节字符（中文等）不被拆散。
 */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || raw.length < 2 || !raw.endsWith('"')) {
    return raw;
  }
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(ch.charCodeAt(0));
      continue;
    }
    const next = body[i + 1];
    if (next == null) {
      bytes.push(0x5c); // 孤立反斜杠，原样保留
      continue;
    }
    if (next >= "0" && next <= "7") {
      // 八进制转义：\ooo（最多 3 位）
      let oct = next;
      let consumed = 1;
      while (consumed < 3) {
        const d = body[i + 1 + consumed];
        if (d == null || d < "0" || d > "7") break;
        oct += d;
        consumed += 1;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      i += consumed;
      continue;
    }
    switch (next) {
      case "\\": bytes.push(0x5c); break;
      case '"': bytes.push(0x22); break;
      case "n": bytes.push(0x0a); break;
      case "t": bytes.push(0x09); break;
      case "r": bytes.push(0x0d); break;
      case "b": bytes.push(0x08); break;
      case "f": bytes.push(0x0c); break;
      case "v": bytes.push(0x0b); break;
      case "a": bytes.push(0x07); break;
      default: bytes.push(next.charCodeAt(0)); break;
    }
    i += 1;
  }
  return Buffer.from(bytes).toString("utf-8");
}

// ── unified diff ─────────────────────────────────────────────────────

export type DiffLine = {
  kind: "context" | "added" | "removed";
  /** 行内容（不含行首 +/-/空格 标记） */
  text: string;
  /** 该行之后跟了 `\ No newline at end of file` 标记 */
  noNewlineAfter?: boolean;
};

export type DiffHunk = {
  /** 原始 `@@ ... @@` 头行全文（含 heading），直接展示 */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffFile = {
  oldPath: string | null;
  newPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  isBinary: boolean;
  hunks: DiffHunk[];
};

/** 展示路径：新路径优先（删除文件回退旧路径） */
export function diffFileDisplayPath(f: DiffFile): string {
  return f.newPath ?? f.oldPath ?? "";
}

// `diff --git` 后的两个路径 token：各自可能 C 引用（含空格/八进制转义）。
// 解析为原始 token 对（保持引用形态，由调用方统一 unquote）。
function splitDiffGitPaths(rest: string): [string, string] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length && tokens.length < 2) {
    if (rest[i] === " ") {
      i += 1;
      continue;
    }
    if (rest[i] === '"') {
      // 引用 token：扫到未转义的收尾引号
      let j = i + 1;
      while (j < rest.length) {
        if (rest[j] === "\\") {
          j += 2;
          continue;
        }
        if (rest[j] === '"') break;
        j += 1;
      }
      tokens.push(rest.slice(i, j + 1));
      i = j + 1;
    } else {
      const j = rest.indexOf(" ", i);
      if (j === -1) {
        tokens.push(rest.slice(i));
        i = rest.length;
      } else {
        tokens.push(rest.slice(i, j));
        i = j;
      }
    }
  }
  return tokens.length === 2 ? [tokens[0], tokens[1]] : null;
}

// 去掉 diff 路径的 a/ b/ 前缀（先反转义再剥前缀，引用形态如 `"a/x"`）
function stripDiffPrefix(raw: string): string {
  const unquoted = unquoteGitPath(raw);
  return unquoted.replace(/^[ab]\//, "");
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** 解析 unified diff 全文为按文件分组的结构（多文件、rename、二进制、空 diff 均容错） */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let lastLine: DiffLine | null = null;

  for (const rawLine of text.split("\n")) {
    // 兼容 CRLF（git 在 Windows 上 diff 输出仍是 LF，这里只是防御）
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith("diff --git ")) {
      current = {
        oldPath: null,
        newPath: null,
        isNew: false,
        isDeleted: false,
        isRename: false,
        isBinary: false,
        hunks: [],
      };
      const pair = splitDiffGitPaths(line.slice("diff --git ".length));
      if (pair) {
        current.oldPath = stripDiffPrefix(pair[0]);
        current.newPath = stripDiffPrefix(pair[1]);
      }
      files.push(current);
      hunk = null;
      lastLine = null;
      continue;
    }
    if (!current) continue; // diff 头之前的噪声行忽略

    if (line.startsWith("new file mode")) {
      current.isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.isDeleted = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.isRename = true;
      current.oldPath = unquoteGitPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.isRename = true;
      current.newPath = unquoteGitPath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.isBinary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4);
      current.oldPath = p === "/dev/null" ? null : stripDiffPrefix(p);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      current.newPath = p === "/dev/null" ? null : stripDiffPrefix(p);
      continue;
    }
    const hunkMatch = line.match(HUNK_RE);
    if (hunkMatch) {
      hunk = {
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] != null ? Number(hunkMatch[2]) : 1,
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] != null ? Number(hunkMatch[4]) : 1,
        lines: [],
      };
      current.hunks.push(hunk);
      lastLine = null;
      continue;
    }
    if (!hunk) continue; // index/mode 等扩展头跳过

    if (line.startsWith("\\")) {
      // `\ No newline at end of file` 挂到上一条内容行
      if (lastLine) lastLine.noNewlineAfter = true;
      continue;
    }
    const marker = line[0];
    if (marker === "+" || marker === "-" || marker === " ") {
      const entry: DiffLine = {
        kind: marker === "+" ? "added" : marker === "-" ? "removed" : "context",
        text: line.slice(1),
      };
      hunk.lines.push(entry);
      lastLine = entry;
    }
    // 其余行（理论不出现）忽略，保证容错
  }
  return files;
}

// ── git stderr 分类（主进程把 stderr 透传给渲染层前的归类依据） ──────

/** stderr 是否「非 git 仓库」错误（git exit 128 的典型文案） */
export function isNotARepoError(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

// ── IPC 入参校验（stage/unstage/diff 的相对路径、commit message） ────

/**
 * 校验并归一化 git 操作的文件路径入参：只接受非空相对路径，
 * 拒绝绝对路径 / NUL / `..` 逃逸（cwd 本身已在白名单内，路径必须留在仓库内）。
 * 合法时原样返回（git 按 cwd 相对解析）；非法返回 null。
 */
export function sanitizeGitRelPaths(paths: unknown): string[] | null {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 500) return null;
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p || p.includes("\0")) return null;
    if (/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) return null; // 绝对路径（Windows 盘符 / POSIX / UNC 根）
    const norm = p.replace(/\\/g, "/");
    const segments = norm.split("/");
    if (segments.includes("..")) return null;
    out.push(p);
  }
  return out;
}

/** commit message 校验：去首尾空白后非空、长度上限 10_000；合法返回 trim 后文本，否则 null */
export function normalizeCommitMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 10_000) return null;
  return trimmed;
}
