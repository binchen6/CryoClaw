/**
 * Settings 埋点统一封装：started/result 一次接入，所有保存类 handler 复用。
 */
import * as analytics from "../analytics";

export type SettingsActionResult = {
  success: boolean;
  message?: string;
};

// 统一封装 Settings 埋点：started/result 一次接入，所有保存类 handler 复用。
export async function runTrackedSettingsAction<T extends SettingsActionResult>(
  action: analytics.SettingsAction,
  props: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const canTrackStructured =
    typeof analytics.trackSettingsActionStarted === "function" &&
    typeof analytics.trackSettingsActionResult === "function";
  if (canTrackStructured) {
    analytics.trackSettingsActionStarted(action, props);
  }
  try {
    const result = await run();
    const latencyMs = Date.now() - startedAt;
    const errorType = result.success
      ? undefined
      : (typeof analytics.classifyErrorType === "function"
        ? analytics.classifyErrorType(result.message)
        : "unknown");
    if (canTrackStructured) {
      analytics.trackSettingsActionResult(action, {
        success: result.success,
        latencyMs,
        errorType,
        props,
      });
    }
    return result;
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const errorType =
      typeof analytics.classifyErrorType === "function"
        ? analytics.classifyErrorType(err)
        : "unknown";
    if (canTrackStructured) {
      analytics.trackSettingsActionResult(action, {
        success: false,
        latencyMs,
        errorType,
        props,
      });
    }
    throw err;
  }
}
