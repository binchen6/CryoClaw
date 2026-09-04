/**
 * Settings: WebBridge（status / precheck / needs-repair / repair-and-enable /
 * pill-repair / install-extensions / clean-blocklist）+ 默认浏览器查询。
 */
import { app, ipcMain, shell } from "electron";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  resolveWebbridgeBinaryPath,
  resolveWebbridgeCrxPath,
  resolveWebbridgeDataDir,
  readWebbridgeCrxMetadata,
  readWebbridgeExtensionId,
} from "../constants";
import {
  applyBrowserModeConfig,
  BROWSER_TARGETS,
  cleanExtensionBlocklist,
  DEFAULT_PROCESS_EXEC,
  detectBrowserMode,
  getBrowserRunningState,
  getDefaultBrowser,
  getExtensionStates,
  installForAllDetectedBrowsers,
  installForDefaultBrowser,
  isBrowserInstalled,
  isExtensionBlocklisted,
  killBackgroundProcesses,
  type DefaultBrowserResult,
  type ExtensionSpec,
} from "../browser";
import {
  getWebbridgeInstallState,
  getWebbridgePrecheck,
  installWebbridge,
  installWebbridgeSkill,
  readCacheManifest,
  resolveWebbridgeExtensionSpec,
  runWebbridgeSetupTask,
  type SetupTaskSummary,
} from "../webbridge";
import { readUserConfig, writeUserConfig } from "../provider-config";
import { assertTrustedIpcSender } from "../ipc-sender-guard";
import * as log from "../logger";
import type { SettingsIpcOptions } from "./types";

// 读取 openclaw.json 中 kimi-webbridge skill 的 enabled 字段（webbridge-precheck 用）。
// 用户可以单独 disable/enable 该 skill，跟 browser.defaultProfile 是两条独立的开关；
// 触发 Settings → 高级"需要修复"banner，修复时 applyBrowserModeConfig 会改回 true。
export const readKimiWebbridgeSkillEnabled = (): boolean | undefined => {
  try {
    const cfg = readUserConfig();
    return cfg?.skills?.entries?.["kimi-webbridge"]?.enabled;
  } catch {
    return undefined;
  }
};
// 当前浏览器模式（来自 detectBrowserMode）。precheck 用它区分：
//   webbridge + enabled=false = 漂移（要修复）
//   非 webbridge + enabled=false = 切换前的初始状态（不算漂移）
export const getCurrentBrowserMode = (): "webbridge" | "openclaw" | "user" => {
  try {
    return detectBrowserMode(readUserConfig());
  } catch {
    return "openclaw";
  }
};
export const specFromExtId = (extId: string): ExtensionSpec => {
  const meta = readWebbridgeCrxMetadata();
  return {
    extId,
    crxPath: resolveWebbridgeCrxPath(),
    crxVersion: meta?.version ?? "",
  };
};
// 在用户的默认浏览器里打开 enable-guide 页面（修复成功且扩展刚装上时调用）。
// setup/webbridge-enable-guide.html 在 packaged 时被打进 app.asar，shell.openExternal
// 不能直接打开 asar 内的文件，所以先读出来写到系统临时目录，再用 file:// 打开。
// ?lang=zh|en, ?browser=chrome|edge —— 让 enable-guide 显示对应的语言和浏览器图标。
//
// 必须 await openExternal 并返回真实结果：
//   - Win 路径形如 `C:\Users\...` 用字符串拼接 `file://${tempPath}` 不是合法 URL，
//     pathToFileURL() 才能正确处理盘符 + 反斜杠 + URL 编码
//   - openExternal 是 Promise；fire-and-forget 让"打开失败"也被当成 success，
//     调用方据此跳过 modal，结果就是用户既看不到引导页也看不到本地提示
const openWebbridgeEnableGuideInBrowser = async (): Promise<boolean> => {
  try {
    const sourcePath = path.join(
      __dirname,
      "..",
      "setup",
      "webbridge-enable-guide.html",
    );
    const tempPath = path.join(
      os.tmpdir(),
      "cryoclaw-webbridge-enable-guide.html",
    );
    const content = fs.readFileSync(sourcePath, "utf-8");
    fs.writeFileSync(tempPath, content, "utf-8");
    const lang = app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en";
    const def = await getDefaultBrowser();
    const browserParam =
      def?.target.id === "edge" ? "edge" : def?.target.id === "chrome" ? "chrome" : "";
    const url = pathToFileURL(tempPath);
    url.searchParams.set("lang", lang);
    if (browserParam) url.searchParams.set("browser", browserParam);
    await shell.openExternal(url.toString());
    return true;
  } catch (err) {
    log.error(
      `[webbridge] open enable-guide failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
};

// 扩展修复前的浏览器准备：缺扩展时检查默认浏览器运行态（前台 → 阻断，
// 后台残留 → 主动清理），随后清 extension blocklist。
// repair-and-enable 与 pill-repair 共用；仅当 missingExtension 时才碰浏览器。
const prepareBrowserForExtensionRepair = async (
  def: DefaultBrowserResult,
  missingExtension: boolean,
  extId: string,
  logTag: string,
): Promise<{ status: "ok" } | { status: "browser-running" }> => {
  if (!missingExtension || !isBrowserInstalled(def.target)) {
    return { status: "ok" };
  }
  const state = await getBrowserRunningState(def.target);
  if (state === "foreground") {
    return { status: "browser-running" };
  }
  if (state === "background-only") {
    const k = await killBackgroundProcesses(def.target);
    log.info(
      `[${logTag}] ${def.target.name} background-only 清理: killed=${k.killed}${
        k.error ? ` error=${k.error}` : ""
      }`,
    );
  }
  // 用户从 UI 卸过扩展会进 external_uninstalls 黑名单，写 JSON 静默失效。
  // 只有 extension 项要修时才需要清；只清默认浏览器。
  if (extId) {
    if (await isExtensionBlocklisted(def.target, extId)) {
      const cleanResult = await cleanExtensionBlocklist(def.target, extId);
      log.info(
        `[${logTag}] ${def.target.name} blocklist cleanup: ${cleanResult}`,
      );
    }
  }
  return { status: "ok" };
};

// 选择性修复：只对真正缺的项跑安装；扩展只装到默认浏览器。
// repair-and-enable 与 pill-repair 共用；扩展只装到默认浏览器。
const runSelectiveWebbridgeRepair = async (
  extId: string,
  binaryPath: string,
  missing: { binary: boolean; skill: boolean; extension: boolean },
): Promise<SetupTaskSummary> =>
  runWebbridgeSetupTask({
    installer: () => installWebbridge({ force: false }),
    installExtensions: async () => {
      const spec = resolveWebbridgeExtensionSpec();
      if (!spec) {
        log.error(
          "[webbridge-repair] 无法解析 ExtensionSpec（CRX 资源缺失），跳过扩展安装",
        );
        return [];
      }
      return installForDefaultBrowser(spec);
    },
    readConfig: readUserConfig,
    writeConfig: writeUserConfig, // fallbackOnFailure:false 下不会被调
    applyMode: applyBrowserModeConfig,
    extensionId: extId,
    installSkill: (bp) => installWebbridgeSkill(bp),
    fallbackOnFailure: false,
    skipBinaryInstall: !missing.binary,
    skipSkillInstall: !missing.skill,
    skipExtensionInstall: !missing.extension,
    existingBinaryPath: binaryPath,
    logger: {
      info: (m) => log.info(m),
      error: (m) => log.error(m),
    },
  });

// 针对默认浏览器的修复前 precheck（repair-and-enable / pill-repair 共用）。
const runDefaultBrowserPrecheck = (
  def: DefaultBrowserResult,
  extId: string,
  binaryPath: string,
) =>
  getWebbridgePrecheck({
    binaryPath,
    extensionId: extId,
    fileExists: fs.existsSync,
    readExtensionStates: (id) =>
      getExtensionStates(specFromExtId(id), {
        processExec: DEFAULT_PROCESS_EXEC,
        processCheckBrowserId: def.target.id,
      }),
    getDefaultBrowser,
    readSkillEnabled: readKimiWebbridgeSkillEnabled,
    currentBrowserMode: getCurrentBrowserMode(),
  });

// 完整 precheck（settings:webbridge-precheck / save-advanced 切 webbridge 服务端兑底共用）：
// 先探测默认浏览器，再查 binary/skill/extension 三项 + skill enabled 漂移。
export const runWebbridgePrecheck = async () => {
  const def = await getDefaultBrowser();
  return getWebbridgePrecheck({
    binaryPath: resolveWebbridgeBinaryPath(),
    extensionId: readWebbridgeExtensionId(),
    fileExists: fs.existsSync,
    readExtensionStates: (extId) =>
      getExtensionStates(specFromExtId(extId), {
        processExec: DEFAULT_PROCESS_EXEC,
        processCheckBrowserId: def?.target.id,
      }),
    getDefaultBrowser,
    readSkillEnabled: readKimiWebbridgeSkillEnabled,
    currentBrowserMode: getCurrentBrowserMode(),
  });
};

// 修复成功后的收尾（repair-and-enable / pill-repair 共用）：
// 写 webbridge config + 重启 gateway——确保新装的 binary/skill enable=true 立即生效；
// 即便已经在 webbridge 模式，applyBrowserModeConfig 也会把 skill enabled 翻回 true（修复 drift）。
// 含扩展修复 → 主动 open 引导页（同时启动浏览器触发"启用扩展"prompt），避免用户多走一步「手动开浏览器」。
const finalizeWebbridgeRepair = async (
  opts: SettingsIpcOptions,
  includesExtension: boolean,
): Promise<boolean> => {
  const config = readUserConfig();
  Object.assign(config, applyBrowserModeConfig(config, "webbridge"));
  writeUserConfig(config);
  opts.requestGatewayRestart?.();
  return includesExtension ? await openWebbridgeEnableGuideInBrowser() : false;
};

export function registerWebbridgeIpc(opts: SettingsIpcOptions): void {
  // ── WebBridge 安装状态（只读，不调 CLI） ──
  // 单一默认浏览器策略：只对默认浏览器查进程，避免 Win 下 Defender 实时扫描 tasklist
  // 翻倍延迟。非默认浏览器上的 running 字段会是 false（我们不再关心）。
  ipcMain.handle("settings:webbridge-status", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:webbridge-status")) throw new Error("IPC sender not trusted");
    try {
      const def = await getDefaultBrowser();
      const state = await getWebbridgeInstallState({
        binaryPath: resolveWebbridgeBinaryPath(),
        dataDir: resolveWebbridgeDataDir(),
        fileExists: fs.existsSync,
        readManifest: readCacheManifest,
        readExtensionStates: (extId) =>
          getExtensionStates(specFromExtId(extId), {
            processExec: DEFAULT_PROCESS_EXEC,
            processCheckBrowserId: def?.target.id,
          }),
        extensionId: readWebbridgeExtensionId(),
      });
      return { success: true, data: state };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── WebBridge 切换前置 precheck（read-only；binary/skill/extension 三项 + default browser） ──
  ipcMain.handle("settings:webbridge-precheck", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:webbridge-precheck")) throw new Error("IPC sender not trusted");
    try {
      const result = await runWebbridgePrecheck();
      return { success: true, data: result };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 拿系统默认浏览器名（给 setup done modal 文案用） ──
  ipcMain.handle("settings:get-default-browser-name", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:get-default-browser-name")) throw new Error("IPC sender not trusted");
    const d = await getDefaultBrowser();
    return {
      success: true,
      data: d ? { id: d.target.id, name: d.target.name } : null,
    };
  });

  // ── 主窗左侧栏「连接你的常用浏览器」pill ──
  // 单一职责：当前是 webbridge 模式 + 扩展实际未在浏览器里启用 → 显示，否则隐藏。
  // 设计前提（来自用户测试用例树）：
  //   - 用户启用 webbridge 后 setup-task 已经把 binary/skill/JSON 装好、清过 blocklist
  //   - 唯一会让扩展不工作的常见情况就是用户没在浏览器弹窗里点"启用"
  //   - 这种情况 CryoClaw 修不了，只能催用户去操作；pill 是纯信息，无 click → repair
  //   - settings 高级页面也不应报"需要修复"（已通过 precheck 简化处理）
  // 退化场景（默认浏览器变成非 Chrome/Edge、binary/skill 被人删了）罕见，pill 隐藏即可——
  // settings 高级页面会通过另一条 precheck 路径暴露这些真坏的状态。
  ipcMain.handle("settings:webbridge-needs-repair", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:webbridge-needs-repair")) throw new Error("IPC sender not trusted");
    try {
      if (getCurrentBrowserMode() !== "webbridge") {
        return { success: true, data: { visible: false, defaultBrowser: null } };
      }
      // pill 可见性 = CryoClaw 组件是否健康 + 用户是否真的启用了扩展
      //   1) 三组件（binary/skill/extension）任一缺 → pill 显示让用户修
      //   2) 三组件都健康但 presentInChrome=false（用户没在浏览器点"启用扩展"）→ pill 仍显示
      //      —— External JSON 写完只是"我们这边装好了"，必须等用户在浏览器里启用才算真正连接
      const extId = readWebbridgeExtensionId();
      const pre = await getWebbridgePrecheck({
        binaryPath: resolveWebbridgeBinaryPath(),
        extensionId: extId,
        fileExists: fs.existsSync,
        readExtensionStates: (id) =>
          getExtensionStates(specFromExtId(id), {
            processExec: DEFAULT_PROCESS_EXEC,
          }),
        getDefaultBrowser,
        readSkillEnabled: readKimiWebbridgeSkillEnabled,
        currentBrowserMode: getCurrentBrowserMode(),
      });
      if (!pre.ok) {
        return {
          success: true,
          data: { visible: true, defaultBrowser: pre.defaultBrowser },
        };
      }
      // 三组件健康——再看用户是否真的启用了扩展
      const def = pre.defaultBrowser;
      if (!def || !extId) {
        return { success: true, data: { visible: false, defaultBrowser: def } };
      }
      const states = await getExtensionStates(specFromExtId(extId), {
        processExec: DEFAULT_PROCESS_EXEC,
        processCheckBrowserId: def.id,
      });
      const enabled = states.find((s) => s.browserId === def.id)
        ?.presentInChrome === true;
      return {
        success: true,
        data: { visible: !enabled, defaultBrowser: def },
      };
    } catch (err: any) {
      return {
        success: true,
        data: { visible: false, defaultBrowser: null },
        message: err?.message,
      };
    }
  });

  // ── WebBridge 修复并启用：按 precheck 结果选择性修复 → 写 config + 重启 gateway ──
  // 单一默认浏览器策略：只对系统默认浏览器（Chrome/Edge）做修复；默认非支持直接拒绝。
  ipcMain.handle("settings:webbridge-repair-and-enable", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:webbridge-repair-and-enable")) throw new Error("IPC sender not trusted");
    try {
      // 0. 默认浏览器必须是 Chrome/Edge，不然没法修
      const def = await getDefaultBrowser();
      if (!def) {
        return {
          success: false,
          code: "DEFAULT_BROWSER_UNSUPPORTED",
          message:
            "系统默认浏览器不是 Chrome 或 Edge，请先在系统设置中修改默认浏览器。",
        };
      }

      const extId = readWebbridgeExtensionId();
      const binaryPath = resolveWebbridgeBinaryPath();

      // 1. 先跑 precheck 知道缺啥（只查默认浏览器的进程，省 1 次 tasklist）
      const pre = await runDefaultBrowserPrecheck(def, extId, binaryPath);

      // 2. 只有 extension 项要修时才检查默认浏览器是否在跑（含清 blocklist）
      //    binary-only / skill-only 修复完全不碰浏览器，没理由勒令关。
      //    Win Edge 经典坑：用户已关窗口但 "Continue running background apps" 让 msedge.exe
      //    后台进程残留，触发 "请退出 Edge" 提示但用户实际已关——区分前台/后台两种状态。
      const prep = await prepareBrowserForExtensionRepair(
        def,
        pre.missing.extension,
        extId,
        "webbridge-repair",
      );
      if (prep.status === "browser-running") {
        return {
          success: false,
          code: "BROWSER_RUNNING",
          browserName: def.target.name,
          message: `${def.target.name} 正在运行；请先完全退出 ${def.target.name} 后再点修复。`,
        };
      }

      // 3. 选择性修复：只对真正缺的项跑安装；扩展只装到默认浏览器
      const summary = await runSelectiveWebbridgeRepair(
        extId,
        binaryPath,
        pre.missing,
      );
      if (summary.outcome !== "webbridge-ready") {
        return {
          success: false,
          code: "REPAIR_FAILED",
          message: summary.error ?? "unknown",
          summary,
        };
      }
      // 三项全过 → 写 webbridge config + 重启 gateway
      const openedBrowser = await finalizeWebbridgeRepair(
        opts,
        pre.missing.extension,
      );
      return { success: true, data: summary, openedBrowser };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 侧边栏 pill 点击 → 完整修复 (binary / skill / extension 三组件，按 precheck 选择性安装) ──
  // 跟 webbridge-repair-and-enable 的区别：
  //   - 假设已经在 webbridge 模式（不切模式），但仍然写 config 重启 gateway 让新装的 binary/skill 生效
  //   - 用户场景：使用中删了 binary/skill，或 skill 关了，重启 gateway 后 pill 应当出现并能一键修
  // 返回 code:
  //   "READY"                       → 修复完成，gateway 已重启
  //   "ALREADY_OK"                  → 三组件都 OK（precheck.ok=true），pill 自然该消失
  //   "BROWSER_RUNNING"             → 缺扩展 + 浏览器在 foreground 跑，前端提示关闭再点
  //   "DEFAULT_BROWSER_UNSUPPORTED" → 默认浏览器不是 Chrome/Edge
  //   "FAILED"                      → 修复中途失败
  ipcMain.handle("settings:webbridge-pill-repair", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:webbridge-pill-repair")) throw new Error("IPC sender not trusted");
    try {
      const def = await getDefaultBrowser();
      if (!def) {
        return { success: false, code: "DEFAULT_BROWSER_UNSUPPORTED" };
      }
      const extId = readWebbridgeExtensionId();
      const binaryPath = resolveWebbridgeBinaryPath();

      // 1. 跑 precheck 知道缺哪几项
      const pre = await runDefaultBrowserPrecheck(def, extId, binaryPath);

      if (pre.ok) {
        // 三组件都健康——再看用户是否真的启用了扩展
        const states = await getExtensionStates(specFromExtId(extId), {
          processExec: DEFAULT_PROCESS_EXEC,
          processCheckBrowserId: def.target.id,
        });
        const enabled = states.find((s) => s.browserId === def.target.id)
          ?.presentInChrome === true;
        if (enabled) {
          return { success: true, code: "ALREADY_OK" };
        }
        // 我们这边都装好了，剩下的是用户去浏览器点「启用扩展」
        // 浏览器关 → 主动 open 引导页（同时启动浏览器，启动时会弹"启用扩展"prompt）
        // 浏览器跑 → 没法自动重启，前端弹 modal 提示「请重启」
        const browserRunning = isBrowserInstalled(def.target)
          ? (await getBrowserRunningState(def.target)) !== "not-running"
          : false;
        const openedBrowser = !browserRunning
          ? await openWebbridgeEnableGuideInBrowser()
          : false;
        return {
          success: true,
          code: "READY",
          browserName: def.target.name,
          includesExtension: true,
          browserRunning,
          openedBrowser,
        };
      }

      // 2. 缺扩展 + 浏览器 foreground → 必须让用户关浏览器（无法 race-safe 清 blocklist）
      // 3. 后台残留清理 + 清 blocklist（仅当要装扩展时）
      const prep = await prepareBrowserForExtensionRepair(
        def,
        pre.missing.extension,
        extId,
        "webbridge-pill-repair",
      );
      if (prep.status === "browser-running") {
        return {
          success: false,
          code: "BROWSER_RUNNING",
          browserName: def.target.name,
        };
      }

      // 4. 选择性修复：按 precheck 缺啥跑啥
      const summary = await runSelectiveWebbridgeRepair(
        extId,
        binaryPath,
        pre.missing,
      );

      if (summary.outcome !== "webbridge-ready") {
        return {
          success: false,
          code: "FAILED",
          message: summary.error ?? "unknown",
        };
      }

      // 5. 写 config 重启 gateway——确保新装的 binary/skill enable=true 立即生效
      // 修复路径走到这里时浏览器一定已关闭（缺扩展时 step 2 已要求关 + 杀 background）
      // 仅 binary/skill 修复 → 不开浏览器，前端弹简短「WebBridge 已修复」modal
      const openedBrowser = await finalizeWebbridgeRepair(
        opts,
        pre.missing.extension,
      );
      return {
        success: true,
        code: "READY",
        browserName: def.target.name,
        // 此次修复是否触及扩展——前端据此决定是否提示用户去浏览器点「启用扩展」
        // 只装 binary/skill 时不需要这条提示，避免误导用户去找弹窗
        includesExtension: pre.missing.extension,
        browserRunning: false,
        openedBrowser,
      };
    } catch (err: any) {
      return {
        success: false,
        code: "FAILED",
        message: err?.message || String(err),
      };
    }
  });

  // ── 重新配置浏览器扩展（幂等；用户手动删了 External Extensions 时的恢复入口） ──
  ipcMain.handle("settings:webbridge-install-extensions", async (event) => {
    if (!assertTrustedIpcSender(event, "settings:webbridge-install-extensions")) throw new Error("IPC sender not trusted");
    try {
      const spec = resolveWebbridgeExtensionSpec();
      if (!spec) {
        return {
          success: false,
          message:
            "本构建未注入 WebBridge 扩展 ID 或缺少内置 CRX（dev 构建？）",
        };
      }
      const summary = await installForAllDetectedBrowsers(spec);
      return { success: true, data: summary };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  });

  // ── 清理 Chrome external_uninstalls 黑名单（用户 UI 卸载过 → 阻断 External Extensions JSON 安装） ──
  ipcMain.handle(
    "settings:webbridge-clean-blocklist",
    async (_evt, browserId: string) => {
    if (!assertTrustedIpcSender(_evt, "settings:webbridge-clean-blocklist")) throw new Error("IPC sender not trusted");
      try {
        const target = BROWSER_TARGETS.find((t) => t.id === browserId);
        if (!target) {
          return { success: false, message: `Unknown browser: ${browserId}` };
        }
        const extId = readWebbridgeExtensionId();
        if (!extId) {
          return {
            success: false,
            message: "本构建未注入 WebBridge 扩展 ID（dev 构建）",
          };
        }
        // 1. 浏览器在跑 → 拒绝（Chrome 启动时会用内存 Preferences 覆盖磁盘改动）
        //    Win Edge 后台残留 → 主动清理（关窗即认为用户意图退出）
        const state = await getBrowserRunningState(target);
        if (state === "foreground") {
          return {
            success: false,
            code: "BROWSER_RUNNING",
            message: `${target.name} 正在运行；请先完全退出后再点清理。`,
          };
        }
        if (state === "background-only") {
          const k = await killBackgroundProcesses(target);
          log.info(
            `[clean-blocklist] ${target.name} background-only 清理: killed=${k.killed}${
              k.error ? ` error=${k.error}` : ""
            }`,
          );
        }
        // 2. 双检：UI 状态可能过期，实际已不在 blocklist
        if (!(await isExtensionBlocklisted(target, extId))) {
          return { success: true, code: "NOT_BLOCKLISTED" };
        }
        // 3. 改 Preferences（含二次读取验证）
        const result = await cleanExtensionBlocklist(target, extId);
        if (result === "verify-failed") {
          return {
            success: false,
            code: "VERIFY_FAILED",
            message: `${target.name} 配置写入后再读取仍命中黑名单；请完全退出 ${target.name} 后重试。`,
          };
        }
        return { success: true, code: result };
      } catch (err: any) {
        return { success: false, message: err.message || String(err) };
      }
    },
  );

}
