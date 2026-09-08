/**
 * tab-mcp-hooks.lib.ts — MCP 服务器与 Webhooks 设置的纯逻辑（可单测）。
 *
 * 配置契约（openclaw 2026.9.2 zod-schema asar 实读取证）：
 * - `mcp.servers.<name>`：{ enabled?, command?, args?[], env{}, cwd?, url?,
 *   transport?: "stdio"|"sse"|"streamable-http", headers?{} }（timeouts/oauth/
 *   toolFilter 等高级字段本 UI 不触碰，编辑时原样保留）。
 * - `hooks.*`：{ enabled?, path?, token?(敏感), defaultSessionKey?, mappings?[] }；
 *   mapping: { id?, match:{path?,source?}, action?:"wake"|"agent", name?,
 *   sessionKey?, sessionMode?:"isolated"|"persistent", messageTemplate? }。
 *
 * 写入走 config.patch（RFC7396）——三条语义要点：
 * 1. record 删键必须显式置 null（缺省键会被合并保留）：删服务器 = servers.<name>=null。
 * 2. 布尔字段必须显式写 false（仅写 true 时旧 false 会被保留）。
 * 3. hooks.mappings 数组由调用方声明 replacePaths 整体替换（内核按 id 就地合并，
 *    逐元素合并会让「清空某字段」永远不生效）。
 * hooks.token 在快照中可能是 REDACTED 哨兵——透传即可，内核写侧自动还原。
 */
import { REDACTED_SENTINEL } from "../../controllers/config.ts";

export type McpTransport = "stdio" | "sse" | "streamable-http";

/** 表单草稿（多行文本字段用「每行一条」的纯文本形态） */
export type McpServerDraft = {
  name: string;
  enabled: boolean;
  transport: McpTransport;
  command: string;
  argsText: string;
  envText: string;
  cwd: string;
  url: string;
  headersText: string;
};

export type McpServerEntry = {
  name: string;
  server: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 从配置树读 MCP 服务器列表（保持定义顺序） */
export function listMcpServers(config: Record<string, unknown> | null | undefined): McpServerEntry[] {
  const servers = asRecord(asRecord(config?.mcp).servers);
  return Object.entries(servers)
    .filter(([, server]) => server !== null)
    .map(([name, server]) => ({ name, server: asRecord(server) }));
}

/** 服务器条目 → 表单草稿 */
export function draftFromServer(entry: McpServerEntry): McpServerDraft {
  const s = entry.server;
  const transport: McpTransport =
    s.transport === "sse" || s.transport === "streamable-http" ? s.transport : "stdio";
  return {
    name: entry.name,
    enabled: s.enabled !== false,
    transport,
    command: typeof s.command === "string" ? s.command : "",
    argsText: Array.isArray(s.args) ? s.args.map(String).join("\n") : "",
    envText: serializeKeyValue(asRecord(s.env), "="),
    cwd: typeof s.cwd === "string" ? s.cwd : "",
    url: typeof s.url === "string" ? s.url : "",
    headersText: serializeKeyValue(asRecord(s.headers), ": "),
  };
}

/** KEY=VALUE / KEY: VALUE 多行文本 → 对象（空键/畸形行忽略） */
export function parseKeyValueLines(text: string, kind: "env" | "headers"): Record<string, string> {
  const out: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = kind === "env" ? trimmed.indexOf("=") : trimmed.indexOf(":");
    if (idx <= 0) continue; // 无分隔符或空键
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out as Record<string, string>;
}

/** 对象 → 多行文本（键序稳定，便于往返） */
export function serializeKeyValue(obj: Record<string, unknown>, sep: string): string {
  return Object.entries(obj)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}${sep}${String(v)}`)
    .join("\n");
}

export type ServerValidation =
  | { ok: true; server: Record<string, unknown> }
  | { ok: false; error: "nameEmpty" | "nameWhitespace" | "nameInvalid" | "commandMissing" | "urlInvalid" };

/**
 * 表单草稿 → 内核 server 对象。只产出本表单拥有的字段（transport=stdio 不产出
 * url/headers，反之不产出 command/args/env/cwd——避免切换 transport 残留对侧字段）；
 * enabled 恒显式写出（RFC7396 布尔语义）。校验：名称非空/无空白包围/不含点与方括号；
 * stdio 必填 command；http 形态必填合法 http(s) URL。
 */
export function serverFromDraft(draft: McpServerDraft): ServerValidation {
  const name = draft.name;
  if (!name.trim()) return { ok: false, error: "nameEmpty" };
  if (name !== name.trim()) return { ok: false, error: "nameWhitespace" };
  if (/[.[\]]/.test(name)) return { ok: false, error: "nameInvalid" };
  const server: Record<string, unknown> = { enabled: draft.enabled };
  if (draft.transport === "stdio") {
    if (!draft.command.trim()) return { ok: false, error: "commandMissing" };
    server.command = draft.command.trim();
    const args = draft.argsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (args.length > 0) server.args = args;
    const env = parseKeyValueLines(draft.envText, "env");
    if (Object.keys(env).length > 0) server.env = env;
    if (draft.cwd.trim()) server.cwd = draft.cwd.trim();
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(draft.url.trim());
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      return { ok: false, error: "urlInvalid" };
    }
    server.url = draft.url.trim();
    const headers = parseKeyValueLines(draft.headersText, "headers");
    if (Object.keys(headers).length > 0) server.headers = headers;
  }
  server.transport = draft.transport;
  return { ok: true, server };
}

/** 本表单独占持有的 server 字段：preserve 合并时剥离，避免切换 transport 残留对侧字段 */
const FORM_OWNED_SERVER_KEYS = new Set([
  "enabled", "transport", "command", "args", "env", "cwd", "url", "headers",
]);

/**
 * 把「目标服务器集合」应用到配置草稿（draft 是 config.get 快照的深拷贝，已含现有
 * mcp.servers）。语义：集合中不再存在的名字显式置 null（RFC7396 删键）；保留的
 * 名字整体覆盖。entries 为空时 mcp.servers 整体删除。`preserveByName`（可选，
 * 编辑场景）给出每个名字的原 server 对象——仅本 UI 不触碰的高级字段（timeouts、
 * oauth、toolFilter…）从中合并回写；表单独占字段先剥离，防止 sse→stdio 切换后
 * 旧 url/headers 残留。
 */
export function applyMcpServersToDraft(
  draft: Record<string, unknown>,
  entries: McpServerEntry[],
  preserveByName?: Record<string, Record<string, unknown>>,
): void {
  const mcp = asRecord(draft.mcp);
  const servers = asRecord(mcp.servers);
  const keep = new Set(entries.map((e) => e.name));
  for (const name of Object.keys(servers)) {
    if (!keep.has(name)) servers[name] = null;
  }
  for (const { name, server } of entries) {
    const preserved = preserveByName?.[name];
    if (preserved) {
      const advanced: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(preserved)) {
        if (!FORM_OWNED_SERVER_KEYS.has(key)) advanced[key] = value;
      }
      servers[name] = Object.keys(advanced).length > 0 ? { ...advanced, ...server } : server;
    } else {
      servers[name] = server;
    }
  }
  if (entries.length === 0) {
    mcp.servers = null;
  } else {
    mcp.servers = servers;
  }
  if (mcp.servers === null) {
    delete mcp.servers;
    if (Object.keys(mcp).length === 0) delete draft.mcp;
    else draft.mcp = mcp;
  } else {
    draft.mcp = mcp;
  }
}

/**
 * 单条目写入（R60 审查 P2 修正）：只 touch 目标名字，集合里其他键（包括保存
 * 等待期间其他进程并发新增的）一律不动——避免陈旧本地集合全量替换在 baseHash
 * 冲突重试路径上静默删除并发变更。`preserve` 传原 server 对象时高级字段原样
 * 合并回写（同 applyMcpServersToDraft 的剥离规则）。draft 内 mcp/servers 缺失时按需创建。
 */
export function upsertMcpServerInDraft(
  draft: Record<string, unknown>,
  name: string,
  server: Record<string, unknown>,
  preserve?: Record<string, unknown>,
): void {
  const mcp = asRecord(draft.mcp);
  const servers = asRecord(mcp.servers);
  if (preserve) {
    const advanced: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(preserve)) {
      if (!FORM_OWNED_SERVER_KEYS.has(key)) advanced[key] = value;
    }
    servers[name] = Object.keys(advanced).length > 0 ? { ...advanced, ...server } : server;
  } else {
    servers[name] = server;
  }
  mcp.servers = servers;
  draft.mcp = mcp;
}

/** 单条目删除：目标名字显式置 null（RFC7396 删键），其余键不动。 */
export function removeMcpServerInDraft(draft: Record<string, unknown>, name: string): void {
  const mcp = asRecord(draft.mcp);
  const servers = asRecord(mcp.servers);
  servers[name] = null;
  mcp.servers = servers;
  draft.mcp = mcp;
}

/* ── Hooks ── */

export type HookMappingDraft = {
  id: string;
  matchPath: string;
  matchSource: string;
  action: "wake" | "agent";
  name: string;
  sessionKey: string;
  sessionMode: "isolated" | "persistent";
  messageTemplate: string;
};

export type HooksState = {
  enabled: boolean;
  path: string;
  token: string;
  defaultSessionKey: string;
  mappings: HookMappingDraft[];
  /** mappings 中携带但本 UI 不编辑的字段（channel/to/model/thinking/…），按 id 回写保留 */
  mappingExtras: Record<string, Record<string, unknown>>;
};

export function hooksFromConfig(config: Record<string, unknown> | null | undefined): HooksState {
  const hooks = asRecord(config?.hooks);
  const rawMappings = Array.isArray(hooks.mappings) ? hooks.mappings : [];
  const mappings: HookMappingDraft[] = [];
  const mappingExtras: Record<string, Record<string, unknown>> = {};
  const seenIds = new Set<string>();
  rawMappings.forEach((raw, index) => {
    const m = asRecord(raw);
    const match = asRecord(m.match);
    // 无 id 的兜底命名须避开已有 id：碰撞会让内核按 id 就地合并，条目静默丢失
    let id = typeof m.id === "string" && m.id ? m.id : `mapping-${index}`;
    while (seenIds.has(id)) id = `${id}-x`;
    seenIds.add(id);
    mappings.push({
      id,
      matchPath: typeof match.path === "string" ? match.path : "",
      matchSource: typeof match.source === "string" ? match.source : "",
      action: m.action === "wake" ? "wake" : "agent",
      name: typeof m.name === "string" ? m.name : "",
      sessionKey: typeof m.sessionKey === "string" ? m.sessionKey : "",
      sessionMode: m.sessionMode === "persistent" ? "persistent" : "isolated",
      messageTemplate: typeof m.messageTemplate === "string" ? m.messageTemplate : "",
    });
    // 深拷贝剥离本 UI 编辑字段，余下字段按 id 原样保留
    const extras: Record<string, unknown> = structuredClone(m);
    delete extras.id;
    delete extras.match;
    delete extras.action;
    delete extras.name;
    delete extras.sessionKey;
    delete extras.sessionMode;
    delete extras.messageTemplate;
    mappingExtras[id] = extras;
  });
  return {
    enabled: hooks.enabled === true,
    path: typeof hooks.path === "string" ? hooks.path : "",
    token: typeof hooks.token === "string" ? hooks.token : "",
    defaultSessionKey: typeof hooks.defaultSessionKey === "string" ? hooks.defaultSessionKey : "",
    mappings,
    mappingExtras,
  };
}

/** orNull：空字符串 → null（RFC7396 删键），非空 → trim 后值 */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * 保存前校验（视图层调用）：返回第一条错误的 i18n 键尾段，null 表示通过。
 * 覆盖内核 superRefine 会拒绝的形态——agent+persistent 需要会话锚点
 * （该条 sessionKey / hooks.defaultSessionKey / extras.transform 三者之一）；
 * 此场景 applyHooksToDraft 会省略 sessionMode，为免用户选择被静默丢弃，先在这里拦下。
 */
export function validateHooks(hooks: HooksState): string | null {
  for (const m of hooks.mappings) {
    if (
      m.action === "agent" &&
      m.sessionMode === "persistent" &&
      !m.sessionKey.trim() &&
      !hooks.defaultSessionKey.trim() &&
      !("transform" in (hooks.mappingExtras[m.id] ?? {}))
    ) {
      return "persistentNeedsAnchor";
    }
  }
  return null;
}

/**
 * hooks 状态 → 配置草稿写入。hooks 顶层 owned 字段显式（空 → null 删键，逐键
 * 合并路径语义正确）；mappings 整体替换（调用方声明 replacePaths），条目内空
 * 字段省略键（见下方 P0 注释）。不触碰的 hooks 子段（presets/gmail/internal/
 * transformsDir…）原样保留。
 * token 透传（含 REDACTED 哨兵，内核自动还原磁盘原值；清空 → null 删除）。
 * 内核 superRefine 约束：action=agent + sessionMode=persistent 且无 sessionKey
 * 且无 defaultSessionKey 且无 transform → 配置报错；此场景不落 sessionMode
 * （视图层在保存前校验并提示，见 tab-mcp-hooks.ts saveHooks）。
 */
export function applyHooksToDraft(draft: Record<string, unknown>, hooks: HooksState): void {
  const next: Record<string, unknown> = { enabled: hooks.enabled };
  const path = orNull(hooks.path);
  if (path !== null) next.path = path;
  else if ("path" in asRecord(draft.hooks)) next.path = null;

  const token = orNull(hooks.token);
  if (token !== null) next.token = token;
  else if ("token" in asRecord(draft.hooks)) next.token = null;

  const defaultSessionKey = orNull(hooks.defaultSessionKey);
  if (defaultSessionKey !== null) next.defaultSessionKey = defaultSessionKey;
  else if ("defaultSessionKey" in asRecord(draft.hooks)) next.defaultSessionKey = null;

  if (hooks.mappings.length > 0) {
    // P0 修正（R60 审查）：mappings 走 replacePaths 整体替换，内核 applyMergePatch
    // 对命中 replacePaths 的数组是字面整体赋值——条目内的 null 不会按 RFC7396 删键，
    // 会被 strict 的 HookMappingSchema 拒绝（"expected string, received null"）。
    // 因此条目内空字段必须【省略键】（整体替换下省略即删除），不能写 null。
    // hooks 顶层的 path/token/defaultSessionKey 不受此影响（逐键合并路径，null 删键正确）。
    next.mappings = hooks.mappings.map((m) => {
      const entry: Record<string, unknown> = { ...structuredClone(hooks.mappingExtras[m.id] ?? {}) };
      entry.id = m.id;
      const matchPath = orNull(m.matchPath);
      const matchSource = orNull(m.matchSource);
      if (matchPath !== null || matchSource !== null) {
        entry.match = {
          ...(matchPath !== null ? { path: matchPath } : {}),
          ...(matchSource !== null ? { source: matchSource } : {}),
        };
      }
      if (m.action !== "agent") entry.action = m.action; // agent 是缺省，省略
      const name = orNull(m.name);
      if (name !== null) entry.name = name;
      const sessionKey = orNull(m.sessionKey);
      if (sessionKey !== null) entry.sessionKey = sessionKey;
      if (m.sessionMode !== "isolated") {
        const hasSessionAnchor = Boolean(sessionKey || hooks.defaultSessionKey.trim());
        // 内核 superRefine：agent+persistent 需 sessionKey/defaultSessionKey/transform 之一
        if (m.action === "wake" || hasSessionAnchor || "transform" in (hooks.mappingExtras[m.id] ?? {})) {
          entry.sessionMode = m.sessionMode;
        }
        // 否则省略（视图层在保存前提示用户，见 tab-mcp-hooks.ts saveHooks 的校验）
      }
      const messageTemplate = orNull(m.messageTemplate);
      if (messageTemplate !== null) entry.messageTemplate = messageTemplate;
      return entry;
    });
  } else {
    next.mappings = null;
  }

  // 无既有 hooks 段且全部为缺省值（enabled=false、path/token/defaultSessionKey/
  // mappings 均为空）时不产生 hooks 键，避免保存一次就写入无意义配置段
  const allDefaults =
    !hooks.enabled &&
    !hooks.path.trim() &&
    !hooks.token.trim() &&
    !hooks.defaultSessionKey.trim() &&
    hooks.mappings.length === 0;
  if (allDefaults && !("hooks" in draft)) {
    return;
  }
  const prev = asRecord(draft.hooks);
  const merged: Record<string, unknown> = { ...prev, ...next };
  if (next.mappings === null) delete merged.mappings;
  draft.hooks = merged;
}

export { REDACTED_SENTINEL };
