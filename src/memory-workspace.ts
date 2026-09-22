/**
 * Memory workspace 数据访问（纯 fs，无 electron 依赖，可单测）。
 *
 * 记忆本体是 openclaw workspace 下的 markdown 文件（内核 2026.9.3 布局）：
 *   MEMORY.md          长期精选记忆（人工/ dreaming 整理后的章节结构）
 *   memory/*.md        每日原始日志（session-memory hook 归档产物）
 *   DREAMS.md          梦境日记（openclaw:dreaming:diary 标记块内为内核托管区）
 *
 * 设置页「记忆 / 梦境」两个分页直接读这些文件展示；召回测试 / 索引重建走
 * 内核 CLI（openclaw memory search|status），见 src/settings/memory.ts。
 */
import * as fs from "fs";
import * as path from "path";

export const MEMORY_FILE = "MEMORY.md";
export const DREAMS_FILE = "DREAMS.md";
export const DAILY_DIR = "memory";

export type WorkspaceMemoryEntry = {
  /** 列表项稳定 id：lt:<n>（MEMORY.md 章节）/ daily:<文件名> */
  id: string;
  kind: "long-term" | "daily";
  title: string;
  /** 展示用摘要（纯文本，已剥离 markdown 标记） */
  snippet: string;
  /** daily 文件的修改时间（long-term 为 null） */
  mtimeMs: number | null;
  bytes: number;
};

export type WorkspaceMemoryList = {
  entries: WorkspaceMemoryEntry[];
  longTermCount: number;
  dailyCount: number;
  /** MEMORY.md 是否存在 */
  hasLongTermFile: boolean;
};

const SNIPPET_MAX = 160;

function toPlainText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^[>#*\-+`\s]+/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`|]/g, "")
    .replace(/\n{2,}/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function makeSnippet(text: string, max = SNIPPET_MAX): string {
  const plain = toPlainText(text);
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

/** MEMORY.md → 章节列表（## / ### 标题切分；首个标题前的导语单独成节） */
export function parseMemorySections(markdown: string): Array<{ title: string; body: string }> {
  const lines = markdown.split(/\r?\n/);
  const sections: Array<{ title: string; body: string }> = [];
  let current: { title: string; body: string } | null = null;
  let preamble: string[] = [];
  for (const line of lines) {
    const m = /^(#{2,4})\s+(.*)$/.exec(line.trim());
    if (m) {
      if (current) sections.push(current);
      else if (preamble.some((l) => l.trim() !== "")) {
        sections.push({ title: "", body: preamble.join("\n") });
      }
      preamble = [];
      current = { title: m[2].trim(), body: "" };
    } else if (current) {
      current.body += `${line}\n`;
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ title: s.title, body: s.body.trim() }));
}

/** 列出 workspace 记忆（MEMORY.md 章节 + memory/*.md 每日日志）。目录缺失不报错。 */
export function listWorkspaceMemory(workspaceDir: string): WorkspaceMemoryList {
  const result: WorkspaceMemoryList = {
    entries: [],
    longTermCount: 0,
    dailyCount: 0,
    hasLongTermFile: false,
  };

  const memoryPath = path.join(workspaceDir, MEMORY_FILE);
  try {
    const md = fs.readFileSync(memoryPath, "utf-8");
    result.hasLongTermFile = true;
    const sections = parseMemorySections(md);
    sections.forEach((sec, i) => {
      const snippet = makeSnippet(sec.body || sec.title);
      if (!snippet) return;
      result.entries.push({
        id: `lt:${i}`,
        kind: "long-term",
        title: sec.title || "(导语)",
        snippet,
        mtimeMs: null,
        bytes: Buffer.byteLength(sec.body || "", "utf-8"),
      });
    });
    result.longTermCount = sections.length;
  } catch {}

  const dailyDir = path.join(workspaceDir, DAILY_DIR);
  try {
    const names = fs
      .readdirSync(dailyDir)
      .filter((n) => n.toLowerCase().endsWith(".md"))
      .filter((n) => !n.startsWith("."))
      .sort();
    for (const name of names) {
      const full = path.join(dailyDir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      let snippet = "";
      try {
        snippet = makeSnippet(fs.readFileSync(full, "utf-8"));
      } catch {}
      result.entries.push({
        id: `daily:${name}`,
        kind: "daily",
        title: name.replace(/\.md$/i, ""),
        snippet,
        mtimeMs: stat.mtimeMs,
        bytes: stat.size,
      });
    }
    result.dailyCount = names.length;
  } catch {}

  return result;
}

/** 读取单条记忆全文（id 由 listWorkspaceMemory 产生）。找不到返回 null。 */
export function readWorkspaceMemoryEntry(
  workspaceDir: string,
  id: string,
): { title: string; content: string; kind: "long-term" | "daily" } | null {
  if (id.startsWith("daily:")) {
    const name = id.slice("daily:".length);
    if (!/^[\w.\- ]+\.md$/i.test(name)) return null;
    const full = path.join(workspaceDir, DAILY_DIR, name);
    try {
      return {
        title: name.replace(/\.md$/i, ""),
        content: fs.readFileSync(full, "utf-8"),
        kind: "daily",
      };
    } catch {
      return null;
    }
  }
  if (id.startsWith("lt:")) {
    const idx = Number(id.slice(3));
    if (!Number.isInteger(idx) || idx < 0) return null;
    try {
      const sections = parseMemorySections(fs.readFileSync(path.join(workspaceDir, MEMORY_FILE), "utf-8"));
      const sec = sections[idx];
      if (!sec) return null;
      return { title: sec.title || "(导语)", content: sec.body, kind: "long-term" };
    } catch {
      return null;
    }
  }
  return null;
}

/** 追加一节到 MEMORY.md（先落 .bak 备份；文件不存在则创建带标题头的骨架）。 */
export function appendMemorySection(workspaceDir: string, title: string, content: string): void {
  const memoryPath = path.join(workspaceDir, MEMORY_FILE);
  const cleanTitle = title.trim().replace(/^#+\s*/, "");
  const cleanContent = content.trim();
  if (!cleanTitle && !cleanContent) throw new Error("empty memory");
  fs.mkdirSync(workspaceDir, { recursive: true });
  let prev = "";
  try {
    prev = fs.readFileSync(memoryPath, "utf-8");
    fs.writeFileSync(`${memoryPath}.bak`, prev, "utf-8");
  } catch {}
  const nl = prev.endsWith("\n") || prev === "" ? "" : "\n";
  const section = `## ${cleanTitle || "未命名记忆"}\n\n${cleanContent}\n`;
  fs.writeFileSync(memoryPath, `${prev}${nl}${section}`, "utf-8");
}

/* ── 梦境日记（DREAMS.md）── */

const DREAMS_START_MARKER = "<!-- openclaw:dreaming:diary:start -->";
const DREAMS_END_MARKER = "<!-- openclaw:dreaming:diary:end -->";

export type DreamEntry = {
  /** 在日记中的序号（0 = 最新，按文件内出现顺序反转后） */
  index: number;
  /** 原始日期行文本，如 "September 7, 2026 at 7:45 AM GMT+8" */
  dateText: string;
  /** 解析失败为 null */
  dateMs: number | null;
  body: string;
};

// 内部定位结果：在 DreamEntry 基础上附带条目在托管区字符串中的 [start, end)
// 字符区间（区间仅覆盖条目正文，不含两侧分隔行）。删除必须按区间切片，
// 不能用日期文本做锚点——两条梦境同日期（精度到分钟）时锚点会命中错误条目，
// 正文恰好含 *同日期文本* 时锚点会命中正文。
type LocatedDreamEntry = DreamEntry & { start: number; end: number };

function parseDreamDate(text: string): number | null {
  // "September 7, 2026 at 7:45 AM GMT+8" → 去掉时区尾巴与 "at" 连接词再解析
  const cleaned = text
    .replace(/GMT[+-]\d+/i, "")
    .replace(/\bat\b/gi, "")
    .replace(/[()*]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const ms = Date.parse(cleaned);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 解析梦境日记：内核托管区（start/end 标记之间，缺标记则全文）里按 `---`
 * 分隔、`*日期*` 开头的条目；返回顺序为最新在前。
 */
export function parseDreamEntries(content: string): DreamEntry[] {
  return locateDreamEntries(content).map(({ index, dateText, dateMs, body }) => ({
    index, dateText, dateMs, body,
  }));
}

// 扫描托管区并给出每条目在托管区字符串中的字符区间（start/end 为文件序，
// 即与 parseDreamEntries 反转前的出现顺序一致）。分隔行本身不算进任何条目。
function locateDreamEntries(content: string): LocatedDreamEntry[] {
  let zone = content;
  let zoneOffset = 0; // zone 在 content 中的起点
  const start = content.indexOf(DREAMS_START_MARKER);
  if (start >= 0) {
    const end = content.indexOf(DREAMS_END_MARKER, start);
    zoneOffset = start + DREAMS_START_MARKER.length;
    zone = end > start ? content.slice(zoneOffset, end) : content.slice(zoneOffset);
  }

  // 与旧 split(/(?:^|\r?\n)[-]{3,}\r?\n/) 等价的分段，但保留每段在 zone 中的偏移
  const segments: Array<{ text: string; offset: number }> = [];
  const sepRe = /(?:^|\r?\n)[-]{3,}\r?\n/g;
  let segStart = 0;
  for (let m = sepRe.exec(zone); m; m = sepRe.exec(zone)) {
    segments.push({ text: zone.slice(segStart, m.index), offset: segStart });
    segStart = m.index + m[0].length;
  }
  segments.push({ text: zone.slice(segStart), offset: segStart });

  const entries: LocatedDreamEntry[] = [];
  for (const seg of segments) {
    // trim 后记录正文在 zone 中的精确区间（切掉首尾空白）
    const leading = seg.text.length - seg.text.trimStart().length;
    const trimmed = seg.text.trim();
    if (trimmed === "") continue;
    const m = /^\*([^*]+)\*\s*\n?([\s\S]*)$/.exec(trimmed);
    if (!m) continue;
    const dateText = m[1].trim();
    const body = m[2].trim();
    if (!dateText && !body) continue;
    entries.push({
      index: 0,
      dateText,
      dateMs: parseDreamDate(dateText),
      body,
      start: zoneOffset + seg.offset + leading,
      end: zoneOffset + seg.offset + leading + trimmed.length,
    });
  }
  // 文件内新条目追加在托管区末尾（旧在前）；展示要最新在前。
  // 反转后 index 即展示序，start/end 区间不受反转影响（指向各自条目原文）。
  entries.reverse();
  return entries.map((e, i) => ({ ...e, index: i }));
}

/** 从日记内容中移除第 index 条（展示序，0 = 最新）。返回 null 表示未找到边界未改动。 */
export function removeDreamEntry(content: string, index: number): string | null {
  const entries = locateDreamEntries(content);
  const target = entries[index];
  if (!target) return null;

  // 按目标条目的字符区间切片删除，吞掉一个相邻分隔行（优先尾部，其次头部），
  // 避免残留空分隔段落。不使用日期文本锚点，同日期条目与正文撞锚均安全。
  const startMarkerIdx = content.indexOf(DREAMS_START_MARKER);
  const zoneStart = startMarkerIdx >= 0 ? startMarkerIdx + DREAMS_START_MARKER.length : 0;
  const endIdx = content.indexOf(DREAMS_END_MARKER, zoneStart);
  const zoneEnd = endIdx >= 0 ? endIdx : content.length;

  let entryStart = target.start;
  let entryEnd = target.end;
  const after = content.slice(entryEnd, zoneEnd);
  const trailingSep = /^\s*[-]{3,}\r?\n/.exec(after);
  if (trailingSep) {
    entryEnd += trailingSep[0].length;
  } else {
    const before = content.slice(zoneStart, entryStart);
    const leadingSep = /(?:^|\r?\n)[-]{3,}\r?\n\s*$/.exec(before);
    if (leadingSep) entryStart -= leadingSep[0].length;
  }

  return content.slice(0, entryStart) + content.slice(entryEnd);
}

/** 删除 DREAMS.md 中第 index 条梦境（先备份 .bak）。返回是否删除成功。 */
export function deleteDreamEntryFile(dreamsPath: string, index: number): boolean {
  let content: string;
  try {
    content = fs.readFileSync(dreamsPath, "utf-8");
  } catch {
    return false;
  }
  const next = removeDreamEntry(content, index);
  if (next === null) return false;
  try {
    fs.writeFileSync(`${dreamsPath}.bak`, content, "utf-8");
    fs.writeFileSync(dreamsPath, next, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/* ── 内核 CLI 输出解析 ── */

/**
 * 从 CLI stdout 提取 JSON 文档（可能混有 [memory] 告警行等括号噪音）：
 * 依次尝试每个 { / [ 起点做括号配平（忽略字符串字面量内的括号），
 * 返回第一个能完整解析的 JSON 文本。
 */
function nextJsonStart(text: string, from: number): number {
  const nextBrace = text.indexOf("{", from);
  const nextBracket = text.indexOf("[", from);
  if (nextBrace < 0) return nextBracket;
  if (nextBracket < 0) return nextBrace;
  return Math.min(nextBrace, nextBracket);
}

export function extractCliJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  for (let start = nextJsonStart(text, 0); start >= 0; start = nextJsonStart(text, start + 1)) {
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break; // 该起点配平后非合法 JSON（如 "[memory] ..."），换下一个起点
          }
        }
      }
    }
  }
  return null;
}

/** 供 spawn 用的 CLI 参数（纯函数便于测试）。 */
export function buildMemoryCliArgs(op: "search" | "reindex", params: { query?: string; maxResults?: number }): string[] {
  if (op === "search") {
    const args = ["memory", "search", "--json"];
    if (params.query && params.query.trim()) args.push("--query", params.query.trim());
    const n = Number(params.maxResults);
    if (Number.isInteger(n) && n > 0 && n <= 50) args.push("--max-results", String(n));
    return args;
  }
  return ["memory", "status", "--index", "--json"];
}

/** 召回测试结果（memory search --json 的防御性形状）。 */
export type MemoryRecallResult = {
  id?: string;
  score?: number;
  content?: string;
  path?: string;
  source?: string;
  [k: string]: unknown;
};

export type MemoryRecallPayload = {
  results: MemoryRecallResult[];
  stale: boolean;
  warning?: string;
  lastError?: string;
};

export function coerceRecallPayload(parsed: unknown): MemoryRecallPayload {
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const results = Array.isArray(obj.results) ? obj.results : [];
  return {
    results: results.map((r) => (r && typeof r === "object" ? (r as MemoryRecallResult) : {})),
    stale: obj.stale === true,
    warning: typeof obj.warning === "string" ? obj.warning : undefined,
    lastError: typeof obj.lastSyncError === "string" ? obj.lastSyncError : undefined,
  };
}

/** reindex（memory status --index --json）结果摘要。 */
export type MemoryIndexStatus = {
  ok: boolean;
  dirty?: boolean;
  files?: number;
  chunks?: number;
  lastSyncError?: string;
};

export function coerceIndexStatus(parsed: unknown): MemoryIndexStatus {
  // CLI 输出是 per-agent 数组，取第一个 agent
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const first = arr.find((x) => x && typeof x === "object") as Record<string, unknown> | undefined;
  if (!first) return { ok: false };
  const status = (first.status && typeof first.status === "object" ? first.status : {}) as Record<string, unknown>;
  return {
    ok: true,
    dirty: status.dirty === true,
    files: typeof status.files === "number" ? status.files : undefined,
    chunks: typeof status.chunks === "number" ? status.chunks : undefined,
    lastSyncError: typeof status.lastSyncError === "string" ? status.lastSyncError : undefined,
  };
}
