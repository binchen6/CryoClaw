/**
 * T3：启动后空闲预热。gateway 健康且主窗口已显示后延迟触发，预拉
 * plugins list（内核 CLI 冷启 ~15s）与技能商店首页列表（HTTP）入各自缓存，
 * 首进扩展页/技能页免冷启等待。预热是纯优化动作：全部吞错记日志，
 * 绝不影响启动与既有功能。
 */
import * as log from "./logger";
import { warmPluginListCache } from "./plugin-store";
import { warmSkillListCache } from "./skill-store";

// 启动关键路径（gateway spawn + 首帧渲染）之后错峰；过短会与首帧争 CPU
const WARMUP_DELAY_MS = 8_000;
let scheduled = false;

export function scheduleCacheWarmupAfterStartup(): void {
  if (scheduled) return;
  scheduled = true;
  const timer = setTimeout(() => {
    void (async () => {
      try {
        await warmPluginListCache();
      } catch (err) {
        log.info(`[preload-warmup] plugin list warm failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await warmSkillListCache();
      } catch (err) {
        log.info(`[preload-warmup] skill list warm failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, WARMUP_DELAY_MS);
  timer.unref?.();
}
