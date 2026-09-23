import type { IconName } from "./icons.ts";
import { icons } from "./icons.ts";
import { t } from "./i18n.ts";
import rawConfig from "./tool-display.json" with { type: "json" };

type ToolDisplayActionSpec = {
  label?: string;
  detailKeys?: string[];
};

type ToolDisplaySpec = {
  icon?: string;
  title?: string;
  label?: string;
  detailKeys?: string[];
  // R52 T4：声明式语言推断键——从 args 的哪个字段取文件路径来做代码语言推断
  langFrom?: string[];
  actions?: Record<string, ToolDisplayActionSpec>;
};

type ToolDisplayConfig = {
  version?: number;
  fallback?: ToolDisplaySpec;
  tools?: Record<string, ToolDisplaySpec>;
};

export type ToolDisplay = {
  name: string;
  icon: IconName;
  title: string;
  label: string;
  /** 插件/MCP 来源（`anysearch__search` → "anysearch"；映射过的内核工具无此项） */
  source?: string;
  verb?: string;
  detail?: string;
};

const TOOL_DISPLAY_CONFIG = rawConfig as ToolDisplayConfig;
const FALLBACK = TOOL_DISPLAY_CONFIG.fallback ?? { icon: "puzzle" };
const TOOL_MAP = TOOL_DISPLAY_CONFIG.tools ?? {};

// R85：图标键名解析。tool-display.json 历史上写的是短横线风格（file-text），
// 而 icons.ts 的键是驼峰（fileText）——不匹配时 icons[key] 为 undefined，
// 内核工具（read/write/exec…）的图标全部渲染为空。这里统一转驼峰并校验存在性，
// 非法名回落 puzzle，杜绝"静默空图标"。
const ICON_KEYS = new Set<string>(Object.keys(icons));
function resolveIconName(raw: string | undefined): IconName {
  if (!raw) {
    return "puzzle";
  }
  const camel = raw.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return (ICON_KEYS.has(camel) ? camel : "puzzle") as IconName;
}

// 未映射工具按「动词段」推断图标：`anysearch__search` 的 search 段 → 搜索图标。
// 只覆盖高频动词；未命中回落 puzzle（与映射工具的 FALLBACK 一致）。
const VERB_ICON: Record<string, string> = {
  search: "search", query: "search", find: "search", grep: "search",
  fetch: "globe", extract: "globe", crawl: "globe", scrape: "globe",
  navigate: "monitor", page: "monitor", screenshot: "monitor",
  read: "fileText", cat: "fileText",
  write: "edit", edit: "edit", update: "edit", patch: "edit", create: "edit",
  exec: "terminal", run: "terminal", shell: "terminal", bash: "terminal", command: "terminal",
  delete: "trash", remove: "trash",
  list: "list", ls: "list",
  memory: "database",
  send: "send", notify: "send", message: "send",
  schedule: "clock", cron: "clock",
  image: "image", draw: "image",
  git: "gitBranch", diff: "diff",
  deploy: "play", build: "play",
};

// R85：工具类型友好名。两类输入都走 i18n（tool.label.*）：
//   1. tool-display.json 映射过的内核工具（read/exec/web_search…）
//   2. 未映射插件/MCP 工具的「动词段」（anysearch__search → search 段）
// 字典未覆盖时回落调用方给的英文兜底，保证任何工具都有可读标签。
function localizedToolLabel(labelKey: string, fallback: string): string {
  const i18nKey = `tool.label.${labelKey}`;
  const localized = t(i18nKey);
  return localized === i18nKey ? fallback : localized;
}

// `前缀__动词` 形态拆解（内核插件与 MCP 的命名约定：mcp__server__tool）。
// 返回 [动词段(小写), 来源展示名]；非该形态返回 null。
// 两段的 `mcp__x` 拆不出有意义的来源（只剩协议前缀），按未限定名处理。
function splitQualifiedToolName(name: string): [string, string] | null {
  const segments = name.split("__").map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  const verb = segments[segments.length - 1].toLowerCase();
  const sourceParts = segments[0].toLowerCase() === "mcp" && segments.length > 2
    ? segments.slice(1, -1)
    : segments.slice(0, -1);
  const source = sourceParts.join("__");
  if (!source || source.toLowerCase() === "mcp") {
    return null;
  }
  return [verb, source];
}

function normalizeToolName(name?: string): string {
  return (name ?? "tool").trim();
}

function defaultTitle(name: string): string {
  const cleaned = name.replace(/_/g, " ").trim();
  if (!cleaned) {
    return "Tool";
  }
  return cleaned
    .split(/\s+/)
    .map((part) =>
      part.length <= 2 && part.toUpperCase() === part
        ? part
        : `${part.at(0)?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join(" ");
}

function normalizeVerb(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/_/g, " ");
}

function coerceDisplayValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
    if (!firstLine) {
      return undefined;
    }
    return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const values = value
      .map((item) => coerceDisplayValue(item))
      .filter((item): item is string => Boolean(item));
    if (values.length === 0) {
      return undefined;
    }
    const preview = values.slice(0, 3).join(", ");
    return values.length > 3 ? `${preview}…` : preview;
  }
  return undefined;
}

function lookupValueByPath(args: unknown, path: string): unknown {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  let current: unknown = args;
  for (const segment of path.split(".")) {
    if (!segment) {
      return undefined;
    }
    if (!current || typeof current !== "object") {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    current = record[segment];
  }
  return current;
}

function resolveDetailFromKeys(args: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = lookupValueByPath(args, key);
    const display = coerceDisplayValue(value);
    if (display) {
      return display;
    }
  }
  return undefined;
}

function resolveReadDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : undefined;
  if (!path) {
    return undefined;
  }
  const offset = typeof record.offset === "number" ? record.offset : undefined;
  const limit = typeof record.limit === "number" ? record.limit : undefined;
  if (offset !== undefined && limit !== undefined) {
    return `${path}:${offset}-${offset + limit}`;
  }
  return path;
}

function resolveWriteDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : undefined;
  return path;
}

function resolveActionSpec(
  spec: ToolDisplaySpec | undefined,
  action: string | undefined,
): ToolDisplayActionSpec | undefined {
  if (!spec || !action) {
    return undefined;
  }
  return spec.actions?.[action] ?? undefined;
}

export function resolveToolDisplay(params: {
  name?: string;
  args?: unknown;
  meta?: string;
}): ToolDisplay {
  const name = normalizeToolName(params.name);
  const key = name.toLowerCase();
  const spec = TOOL_MAP[key];
  // R85：未映射的 `插件__动词` 名按动词段解析（label/icon 都吃动词段推断），
  // 来源段进 display.source 由渲染层做小徽标，用户不再面对 anysearch__search 这类内部名。
  const qualified = spec ? null : splitQualifiedToolName(name);
  const labelKey = qualified?.[0] ?? key;
  const icon = resolveIconName(spec?.icon ?? VERB_ICON[labelKey]);
  const title = spec?.title ?? defaultTitle(name);
  const label = localizedToolLabel(
    labelKey,
    spec?.label ?? (qualified ? defaultTitle(labelKey) : defaultTitle(name)),
  );
  const actionRaw =
    params.args && typeof params.args === "object"
      ? ((params.args as Record<string, unknown>).action as string | undefined)
      : undefined;
  const action = typeof actionRaw === "string" ? actionRaw.trim() : undefined;
  const actionSpec = resolveActionSpec(spec, action);
  const verb = normalizeVerb(actionSpec?.label ?? action);

  let detail: string | undefined;
  if (key === "read") {
    detail = resolveReadDetail(params.args);
  }
  if (!detail && (key === "write" || key === "edit" || key === "attach")) {
    detail = resolveWriteDetail(params.args);
  }

  const detailKeys = actionSpec?.detailKeys ?? spec?.detailKeys ?? FALLBACK.detailKeys ?? [];
  if (!detail && detailKeys.length > 0) {
    detail = resolveDetailFromKeys(params.args, detailKeys);
  }

  if (!detail && params.meta) {
    detail = params.meta;
  }

  if (detail) {
    detail = shortenHomeInString(detail);
  }

  return {
    name,
    icon,
    title,
    label,
    ...(qualified?.[1] ? { source: qualified[1] } : {}),
    verb,
    detail,
  };
}

export function formatToolDetail(display: ToolDisplay): string | undefined {
  const parts: string[] = [];
  if (display.verb) {
    parts.push(display.verb);
  }
  if (display.detail) {
    parts.push(display.detail);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(" · ");
}

function shortenHomeInString(input: string): string {
  if (!input) {
    return input;
  }
  return input
    .replace(/\/Users\/[^/]+/g, "~")
    .replace(/\/home\/[^/]+/g, "~")
    // 主平台是 Windows：C:\Users\xxx 形态也缩写（注意正则里的反斜杠要二次转义）
    .replace(/[A-Za-z]:\\Users\\[^\\/]+/g, "~");
}

// ── R52 T4：工具输出语言推断 ──
// read/write/edit/apply_patch 类工具的输出（尤其 read 的文件内容）在 sidebar
// 里按代码围栏渲染；语言从 args 里的文件路径扩展名推断。映射目标与
// chat/code-block-enhance.ts 的 LANG_LOADERS（已注册的 hljs 语言）保持一致，
// 未注册的扩展名返回 undefined（纯文本围栏或直接渲染）。

// json 未声明 langFrom 时的兜底：文件改写/读取类工具默认从 path 推断
const FILE_TOOL_LANG_FALLBACK_KEYS = ["path"];
const FILE_TOOL_NAMES = new Set(["read", "write", "edit", "apply_patch", "attach"]);

const EXT_LANGUAGE_MAP: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  py: "python",
  json: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  css: "css",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  java: "java",
  go: "go",
  rs: "rust",
  yml: "yaml",
  yaml: "yaml",
  ps1: "powershell",
};

export function inferLanguageFromPath(path: string): string | undefined {
  const cleaned = (path.trim().split(/[?#]/)[0] ?? "").trim();
  if (!cleaned) {
    return undefined;
  }
  const base = cleaned.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  // 无扩展名 / 点号文件（.gitignore）/ 结尾点：不推断
  if (dot <= 0 || dot === base.length - 1) {
    return undefined;
  }
  return EXT_LANGUAGE_MAP[base.slice(dot + 1).toLowerCase()];
}

export function resolveToolLanguage(name?: string, args?: unknown): string | undefined {
  const key = normalizeToolName(name).toLowerCase();
  const spec = TOOL_MAP[key];
  const langKeys =
    spec?.langFrom ?? (FILE_TOOL_NAMES.has(key) ? FILE_TOOL_LANG_FALLBACK_KEYS : undefined);
  if (!langKeys || langKeys.length === 0) {
    return undefined;
  }
  for (const langKey of langKeys) {
    const value = lookupValueByPath(args, langKey);
    if (typeof value !== "string") {
      continue;
    }
    const lang = inferLanguageFromPath(value);
    if (lang) {
      return lang;
    }
  }
  return undefined;
}
