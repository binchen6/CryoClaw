import type { LogLevel } from "./types.ts";
import type { CronFormState } from "./ui-types.ts";


export const DEFAULT_CRON_FORM: CronFormState = {
  name: "",
  description: "",
  agentId: "",
  enabled: true,
  scheduleKind: "daily",
  scheduleAt: "",
  everyAmount: "30",
  everyUnit: "minutes",
  cronExpr: "10:00",
  cronTz: "",
  sessionTarget: "isolated",
  wakeMode: "now",
  payloadKind: "agentTurn",
  payloadText: "",
  payloadModel: "",
  deliveryMode: "announce",
  deliveryChannel: "last",
  deliveryTo: "",
  timeoutSeconds: "",
};
