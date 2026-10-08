import type { GatewayBrowserClient } from "../gateway.ts";
import { t } from "../i18n.ts";
import type { SkillStatusEntry, SkillStatusReport } from "../types.ts";

export type SkillsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  skillsLoading: boolean;
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
    await loadSkills(state);
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

// skills 加载超时：QA 捕获过 skills.status 永不返回导致「刷新中」常驻——
// 15s 未 settle 即判加载失败（走错误态 + 重试），与网关侧 30s 请求超时解耦。
export const SKILLS_LOAD_TIMEOUT_MS = 15_000;

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

export async function loadSkills(state: SkillsState, options?: LoadSkillsOptions) {
  if (options?.clearMessages && Object.keys(state.skillMessages).length > 0) {
    state.skillMessages = {};
  }
  if (!state.client || !state.connected) {
    return;
  }
  if (state.skillsLoading) {
    return;
  }
  state.skillsLoading = true;
  state.skillsError = null;
  try {
    const res = await withLoadTimeout(
      state.client.request<SkillStatusReport | undefined>("skills.status", {}),
      SKILLS_LOAD_TIMEOUT_MS,
    );
    if (res) {
      state.skillsReport = res;
    }
  } catch (err) {
    // 裸错误（gateway request timeout / Error: unknown method ...）只进 console，
    // UI 统一走友好文案 + 重试（渲染层 skillsError → skill-store__error 出重试按钮）
    console.warn("[skills] skills.status failed:", err);
    state.skillsError = t("skillStore.error");
  } finally {
    state.skillsLoading = false;
  }
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
 * 请求失败时返回空数组（菜单降级为空，不打断对话）。
 */
export async function listEligibleSkills(
  state: Pick<SkillsState, "client" | "connected">,
): Promise<EligibleSkillOption[]> {
  if (!state.client || !state.connected) {
    return [];
  }
  try {
    const res = await state.client.request<{ skills?: SkillStatusEntry[] } | undefined>(
      "skills.status",
      {},
    );
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
    return [];
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
