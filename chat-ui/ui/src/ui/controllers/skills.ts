import type { GatewayBrowserClient } from "../gateway.ts";
import { t } from "../i18n.ts";
import { ResourceCache } from "../utils/resource-cache.ts";
import type { SkillStatusEntry, SkillStatusReport } from "../types.ts";

export type SkillsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  skillsLoading: boolean;
  skillsLoadSlow?: boolean;
  skillsReport: SkillStatusReport | null;
  skillsError: string | null;
  skillsBusyKey: string | null;
  skillEdits: Record<string, string>;
  skillMessages: SkillMessageMap;
};

export type SkillMessage = {
  kind: "success" | "error";
  message: string;
};

export type SkillMessageMap = Record<string, SkillMessage>;

type LoadSkillsOptions = {
  clearMessages?: boolean;
  force?: boolean;
};

function setSkillMessage(state: SkillsState, key: string, message?: SkillMessage) {
  if (!key.trim()) {
    return;
  }
  const next = { ...state.skillMessages };
  if (message) {
    next[key] = message;
  } else {
    delete next[key];
  }
  state.skillMessages = next;
}

function getErrorMessage(err: unknown) {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// skills 写操作统一骨架（updateSkillEnabled / saveSkillApiKey / installSkill 共用）：
// busy 标记 → 执行动作 → 刷新列表 + 成功/失败消息 → busy 复位。action 返回成功消息文本。
async function runSkillMutation(
  state: SkillsState,
  skillKey: string,
  action: () => Promise<string>,
) {
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    const message = await action();
    await loadSkills(state, { force: true });
    setSkillMessage(state, skillKey, {
      kind: "success",
      message,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}

// Match the native discovery worker's bounded 120s operation. A 15s UI-only
// timeout used to abandon live reads and enqueue duplicates during rescans.
export const SKILLS_LOAD_TIMEOUT_MS = 120_000;
export const SKILLS_SLOW_HINT_MS = 15_000;

// 导出供单测用小的 ms 直接驱动（loadSkills 内部用 SKILLS_LOAD_TIMEOUT_MS 调用）。
export function withLoadTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("skills load timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

type StatusRead = { revision: number; promise: Promise<SkillStatusReport> };
type SkillStatusState = {
  cache: ResourceCache<SkillStatusReport>;
  revision: number;
  refreshRequested: boolean;
  refreshSupported?: boolean;
  pending?: StatusRead;
};
const skillStatusCaches = new WeakMap<GatewayBrowserClient, SkillStatusState>();
function skillStatusStateFor(client: GatewayBrowserClient) {
  let state = skillStatusCaches.get(client);
  if (!state) {
    state = { cache: new ResourceCache<SkillStatusReport>(10_000, 2), revision: 0, refreshRequested: false };
    skillStatusCaches.set(client, state);
  }
  return state;
}
function invalidateSkillStatus(client: GatewayBrowserClient) {
  const state = skillStatusStateFor(client);
  state.revision++;
  state.refreshRequested = true;
  state.cache.clear();
}

async function requestSkillStatus(client: GatewayBrowserClient, state: SkillStatusState, refresh: boolean) {
  const options = { timeoutMs: SKILLS_LOAD_TIMEOUT_MS };
  const refreshNative = refresh && state.refreshSupported !== false;
  try {
    const report = await client.request<SkillStatusReport>("skills.status", refreshNative ? { refresh: true } : {}, options);
    if (refreshNative) state.refreshSupported = true;
    return report;
  } catch (error) {
    // Older kernels have a closed params schema without `refresh`. Only retry
    // that specific pre-admission rejection; permissions/timeouts stay errors.
    if (refreshNative && error && typeof error === "object" &&
        "code" in error && error.code === "INVALID_REQUEST" &&
        error instanceof Error && /refresh/i.test(error.message) && /additional|unexpected|unknown|unrecognized/i.test(error.message)) {
      state.refreshSupported = false;
      return client.request<SkillStatusReport>("skills.status", {}, options);
    }
    throw error;
  }
}
/** One native read per connection, including consumers with different UI state.
 * A mutation invalidates its generation; join the older read before observing
 * fresh state instead of flooding the singleton discovery worker. */
async function readSkillStatus(client: GatewayBrowserClient): Promise<SkillStatusReport> {
  const state = skillStatusStateFor(client);
  for (;;) {
    const cached = state.cache.peek("status");
    if (cached) return cached;
    let read = state.pending;
    if (!read) {
      const revision = state.revision;
      const promise = withLoadTimeout(requestSkillStatus(client, state, state.refreshRequested), SKILLS_LOAD_TIMEOUT_MS);
      read = { revision, promise };
      state.pending = read;
      const owned = read;
      const release = () => { if (state.pending === owned) state.pending = undefined; };
      promise.then(release, release);
    }
    const report = await read.promise;
    if (read.revision !== state.revision) continue;
    if (!report || !Array.isArray(report.skills)) throw new Error("Invalid skill status response");
    state.refreshRequested = false;
    state.cache.store("status", report);
    return report;
  }
}

type SkillsLoad = { client: GatewayBrowserClient; promise: Promise<void> | null };
const skillLoads = new WeakMap<SkillsState, SkillsLoad>();

type StartupRefresh = { attempted: boolean; timer?: ReturnType<typeof setTimeout> };
const startupRefreshes = new WeakMap<SkillsState, StartupRefresh>();

/** One attempt per app view lifetime, after visible startup reads. Reconnects
 * can reschedule an unstarted job, but never create a periodic discovery loop. */
export function queueStartupSkillRefresh(state: SkillsState, isReady: () => boolean) {
  if (!isReady()) return;
  let job = startupRefreshes.get(state);
  if (!job) { job = { attempted: false }; startupRefreshes.set(state, job); }
  if (job.attempted || job.timer !== undefined) return;
  const owned = job;
  job.timer = setTimeout(() => {
    owned.timer = undefined;
    if (!isReady()) return;
    owned.attempted = true;
    void loadSkills(state, { force: true });
  }, 1_000);
}

export function cancelStartupSkillRefresh(state: SkillsState) {
  const job = startupRefreshes.get(state);
  if (job?.timer !== undefined) { clearTimeout(job.timer); job.timer = undefined; }
}

export async function loadSkills(state: SkillsState, options?: LoadSkillsOptions) {
  if (options?.clearMessages && Object.keys(state.skillMessages).length > 0) state.skillMessages = {};
  if (!state.client || !state.connected) return;
  const client = state.client, status = skillStatusStateFor(client);
  if(options?.force)invalidateSkillStatus(client);
  const active = skillLoads.get(state);
  if (active?.client === client && active.promise) {
    return active.promise;
  }
  if (!options?.force) {
    const cached = status.cache.peek("status");
    if (cached) { state.skillsReport = cached; state.skillsError = null; return; }
  }
  const load: SkillsLoad = { client, promise: null };
  skillLoads.set(state, load);
  const current = () => skillLoads.get(state) === load && state.client === client && state.connected;
  state.skillsLoading = true;
  state.skillsLoadSlow = false;
  state.skillsError = null;
  const slowTimer=setTimeout(()=>{if(current())state.skillsLoadSlow=true;},SKILLS_SLOW_HINT_MS);
  load.promise = (async () => {
      try {
        const report = await readSkillStatus(client);
        if (!current()) return;
        state.skillsReport = report;
        state.skillsError = null;
      } catch (error) {
        console.warn("[skills] skills.status failed:", error);
        if (current()) state.skillsError = t("skillStore.error");
      }
  })().finally(() => {
    clearTimeout(slowTimer);
    if (skillLoads.get(state) === load) { load.promise = null; state.skillsLoading = false; state.skillsLoadSlow=false; }
  });
  return load.promise;
}

export function updateSkillEdit(state: SkillsState, skillKey: string, value: string) {
  state.skillEdits = { ...state.skillEdits, [skillKey]: value };
}

export async function updateSkillEnabled(state: SkillsState, skillKey: string, enabled: boolean) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  await runSkillMutation(state, skillKey, async () => {
    await client.request("skills.update", { skillKey, enabled });
    return enabled ? t("skills.messageEnabled") : t("skills.messageDisabled");
  });
}

export async function saveSkillApiKey(state: SkillsState, skillKey: string) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  await runSkillMutation(state, skillKey, async () => {
    const apiKey = state.skillEdits[skillKey] ?? "";
    await client.request("skills.update", { skillKey, apiKey });
    return t("skills.messageApiKeySaved");
  });
}

export type EligibleSkillOption = {
  key: string;
  name: string;
  description?: string;
  emoji?: string;
};

/**
 * 引用技能列表：走官方 skills.status，过滤 disabled / ineligible 后供对话页加号菜单展示。
 * Bound the load and reject errors so the menu can show a retry action.
 */
export async function listEligibleSkills(
  state: Pick<SkillsState, "client" | "connected">,
): Promise<EligibleSkillOption[]> {
  if (!state.client || !state.connected) {
    return [];
  }
  const client=state.client;
  try {
    const res = await readSkillStatus(client);
    if(state.client!==client || !state.connected)return [];
    const skills = res?.skills ?? [];
    return skills
      .filter((sk) => sk.eligible !== false && !sk.disabled)
      .map((sk) => ({
        key: sk.skillKey,
        name: sk.name ?? sk.skillKey,
        description: typeof sk.description === "string" ? sk.description : undefined,
        emoji: typeof sk.emoji === "string" ? sk.emoji : undefined,
      }));
  } catch {
    throw new Error(t("skillStore.error"));
  }
}

export async function installSkill(
  state: SkillsState,
  skillKey: string,
  name: string,
  installId: string,
) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  await runSkillMutation(state, skillKey, async () => {
    // skills.install 可能跑 npm/git 安装，走 per-request 长超时（120s），不用默认 30s
    const result = await client.request<{ message?: string }>(
      "skills.install",
      {
        name,
        installId,
        timeoutMs: 120000,
      },
      { timeoutMs: 120_000 },
    );
    return result?.message ?? t("skills.messageInstalled");
  });
}
