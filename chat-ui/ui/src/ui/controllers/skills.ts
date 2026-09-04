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
    const res = await state.client.request<SkillStatusReport | undefined>("skills.status", {});
    if (res) {
      state.skillsReport = res;
    }
  } catch (err) {
    state.skillsError = getErrorMessage(err);
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
