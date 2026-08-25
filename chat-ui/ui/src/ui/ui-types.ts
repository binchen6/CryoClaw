/**
 * UI-specific types used by the chat and cron form views.
 */

export type ChatAttachment = {
  id: string;
  name?: string;
  type?: string;
  size?: number;
  dataUrl?: string;
  url?: string;
  /** 本地文件绝对路径（非图片附件，发送时拼到消息前面） */
  filePath?: string;
  [key: string]: unknown;
};

export type ChatQueueItem = {
  id: string;
  message: string;
  attachments?: ChatAttachment[];
  timestamp?: number;
  [key: string]: unknown;
};

/** 已配置的模型（从 Settings 聚合所有 provider 的模型列表） */
export interface ConfiguredModel {
  key: string;      // "providerKey/modelId"
  name: string;     // 别名或模型 id
  provider: string;
  isDefault: boolean;
}

export type CronFormState = {
  name: string;
  description: string;
  agentId: string;
  enabled: boolean;
  // daily 是 UI 专用 kind（controllers/cron.ts 转为每日 cron 表达式），
  // 收录进联合类型消除 as any 的类型谎言（gotcha #56：typecheck 盲区需靠类型防护）。
  scheduleKind: "daily" | "at" | "every" | "cron";
  scheduleAt: string;
  everyAmount: string;
  everyUnit: string;
  cronExpr: string;
  cronTz: string;
  sessionTarget: string;
  wakeMode: string;
  payloadKind: "agentTurn" | "systemEvent";
  payloadText: string;
  /** cron agentTurn 可选模型 key（provider/model），空 = 默认模型 */
  payloadModel: string;
  deliveryMode: string;
  deliveryChannel: string;
  deliveryTo: string;
  timeoutSeconds: string;
};
