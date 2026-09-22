// gateway-lifecycle.test.ts — GatewayProcess 生命周期状态转移判定
// （P0-1 doStart 预启动与 stop() 竞态、P0-2 崩溃重启双链、L2 tasklist fail-closed）
// 纯函数抽出（对齐 gateway-crash-restart.ts 模式），不依赖实例状态。
import { describe, expect, test } from "vitest";
import {
  shouldAbortStartAfterPrestart,
  shouldForceResetHalfDead,
  shouldFireCrashOnStartingExit,
  parseTasklistImageName,
  isPlausibleGatewayImage,
  isPlausiblyOwnGatewayFromTasklist,
} from "./gateway-lifecycle";

describe("shouldAbortStartAfterPrestart（P0-1：预启动后 spawn 前复查）", () => {
  test("仍为 starting → 不中止，允许继续 spawn", () => {
    expect(shouldAbortStartAfterPrestart("starting")).toBe(false);
  });

  test("预启动期间被 stop() 复位 stopped → 中止（否则退出/导入路径留孤儿）", () => {
    expect(shouldAbortStartAfterPrestart("stopped")).toBe(true);
  });

  test("stopping / running → 中止（状态机已不由本次启动拥有）", () => {
    expect(shouldAbortStartAfterPrestart("stopping")).toBe(true);
    expect(shouldAbortStartAfterPrestart("running")).toBe(true);
  });
});

describe("shouldForceResetHalfDead（P0-1：stop() 半死态处理判定）", () => {
  test("starting + 无 proc + 无在途启动 → 强制复位 stopped（历史半死态恢复）", () => {
    expect(shouldForceResetHalfDead("starting", false, false)).toBe(true);
  });

  test("starting + 无 proc + 有在途 doStart → 不强制复位，改走等待落定分支", () => {
    // 预启动窗口（proc 尚未赋值）强转 stopped 会让 doStart 继续 spawn 出孤儿
    expect(shouldForceResetHalfDead("starting", false, true)).toBe(false);
  });

  test("已有子进程句柄 → 不强制复位（走正常停止流程）", () => {
    expect(shouldForceResetHalfDead("starting", true, false)).toBe(false);
    expect(shouldForceResetHalfDead("starting", true, true)).toBe(false);
  });

  test("非 starting 态 → 不强制复位", () => {
    expect(shouldForceResetHalfDead("stopped", false, false)).toBe(false);
    expect(shouldForceResetHalfDead("running", false, false)).toBe(false);
    expect(shouldForceResetHalfDead("stopping", false, false)).toBe(false);
  });
});

describe("shouldFireCrashOnStartingExit（P0-2：退出是否触发 onCrash 的判定矩阵）", () => {
  test("running 退出：无论是否有监督在途都触发（restart 链全靠 onCrash 恢复）", () => {
    expect(shouldFireCrashOnStartingExit("running", false)).toBe(true);
    expect(shouldFireCrashOnStartingExit("running", true)).toBe(true);
  });

  test("starting 退出 + 监督链在途（ensureGatewayRunning 重试中）→ 不触发", () => {
    // 监督链自己带 3 次重试与失败上报，再排崩溃重启链会双倍消耗预算、双恢复入口
    expect(shouldFireCrashOnStartingExit("starting", true)).toBe(false);
  });

  test("starting 退出 + 非监督启动（restart 链的 start）→ 触发", () => {
    expect(shouldFireCrashOnStartingExit("starting", false)).toBe(true);
  });

  test("stopping / stopped 退出：主动停止路径，绝不触发", () => {
    expect(shouldFireCrashOnStartingExit("stopping", false)).toBe(false);
    expect(shouldFireCrashOnStartingExit("stopping", true)).toBe(false);
    expect(shouldFireCrashOnStartingExit("stopped", false)).toBe(false);
  });
});

describe("tasklist 镜像名解析与身份判定（L2：fail-closed）", () => {
  test("cryoclaw / electron / node 镜像名通过（小写输入；大小写折叠在解析层）", () => {
    expect(isPlausibleGatewayImage("cryoclaw.exe")).toBe(true);
    expect(isPlausibleGatewayImage("electron.exe")).toBe(true);
    expect(isPlausibleGatewayImage("node.exe")).toBe(true);
    // 大写经 parseTasklistImageName 折叠后同样放行
    expect(isPlausiblyOwnGatewayFromTasklist('"CryoClaw.exe","1234","Console","1","1","0 K"')).toBe(true);
  });

  test("无关服务镜像名拒绝（防误杀占用 18789 端口的其他服务）", () => {
    expect(isPlausibleGatewayImage("svchost.exe")).toBe(false);
    expect(isPlausibleGatewayImage("nginx.exe")).toBe(false);
    expect(isPlausibleGatewayImage("")).toBe(false);
  });

  test("CSV 首行解析：去引号、取镜像名列、小写化", () => {
    expect(parseTasklistImageName('"CryoClaw.exe","1234","Console","1","1","234,567 K"')).toBe("cryoclaw.exe");
    expect(parseTasklistImageName("node.exe,5678,Services,0,2,98,765 K")).toBe("node.exe");
  });

  test("空 stdout（无匹配进程）→ 解析为空，整体判定拒绝", () => {
    expect(parseTasklistImageName("")).toBe("");
    expect(parseTasklistImageName("\r\n")).toBe("");
    expect(isPlausiblyOwnGatewayFromTasklist("")).toBe(false);
    expect(isPlausiblyOwnGatewayFromTasklist("\r\n   \r\n")).toBe(false);
  });

  test("完整判定：tasklist 输出 → 放行/拒绝", () => {
    const own = '"electron.exe","4242","Console","1","1","123,456 K"\r\n';
    const foreign = '"SomeRandomService.exe","4242","Services","0","2","9,876 K"\r\n';
    expect(isPlausiblyOwnGatewayFromTasklist(own)).toBe(true);
    expect(isPlausiblyOwnGatewayFromTasklist(foreign)).toBe(false);
  });
});
