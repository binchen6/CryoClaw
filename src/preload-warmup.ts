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
let warmupTimer: ReturnType<typeof setTimeout> | null = null;
let cancelled = false;

export function scheduleCacheWarmupAfterStartup(): void {
  if (scheduled) return;
  scheduled = true;
  warmupTimer = setTimeout(() => {
    warmupTimer = null;
    if (cancelled) return;
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
  warmupTimer.unref?.();
}

/**
 * 取消预热（R94 更新换装交接前调用）：换装会强杀应用进程，预热启动的
 * CryoClaw Helper.exe 子进程若存活会占住安装目录文件、干扰旧版卸载。
 * 未触发则清掉定时器；已触发则在途子进程由 killTrackedKernelCliChildren 终止。
 */
export function cancelCacheWarmup(): void {
  cancelled = true;
  if (warmupTimer !== null) {
    clearTimeout(warmupTimer);
    warmupTimer = null;
  }
}
