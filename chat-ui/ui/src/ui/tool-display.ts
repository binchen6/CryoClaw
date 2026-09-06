import type { IconName } from "./icons.ts";
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
  verb?: string;
  detail?: string;
};

const TOOL_DISPLAY_CONFIG = rawConfig as ToolDisplayConfig;
const FALLBACK = TOOL_DISPLAY_CONFIG.fallback ?? { icon: "puzzle" };
const TOOL_MAP = TOOL_DISPLAY_CONFIG.tools ?? {};

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
  const icon = (spec?.icon ?? FALLBACK.icon ?? "puzzle") as IconName;
  const title = spec?.title ?? defaultTitle(name);
  const label = spec?.label ?? name;
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
  return input.replace(/\/Users\/[^/]+/g, "~").replace(/\/home\/[^/]+/g, "~");
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
