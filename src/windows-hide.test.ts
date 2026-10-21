// windows-hide.test.ts — Windows 控制台闪窗回归守卫（静态扫描）。
// 背景：spawn/exec 拉起控制台子系统程序（taskkill/git/…）时缺 windowsHide:true
// 会闪现控制台黑窗。本测试扫描 src/ 全部非测试 TS 文件：凡调用点（spawn(/
// execFile(/execSync(/execFileSync() 向后 600 字符窗口内命中控制台程序名，
// 同窗口必须出现 windowsHide；否则失败并倒逼显式决策——补 windowsHide，或将
// 文件加入 ALLOWLIST 并注释原因。tasks/memory/pairing/tray 的 taskkill、git
// 闪窗修复（R94）即由本守卫防回归。
import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";

// 测试由仓库根目录的 npm scripts / vitest 启动，cwd 即仓库根
const SRC_DIR = path.join(process.cwd(), "src");

const CALL_RE = /\b(spawn|execFile|execSync|execFileSync)\s*\(/g;
// 控制台子系统程序：调用这些程序时缺 windowsHide 必闪窗
const CONSOLE_PROGRAM_RE = /\b(taskkill|tasklist|netstat|schtasks|reg\.exe|git|docker)\b/;
const WINDOW_CHARS = 600;

// 整文件豁免清单（相对 src/ 路径）。闪窗是用户可见缺陷，豁免必须注释原因，
// 测试会断言每条理由非空——不允许无说明的裸豁免。
const ALLOWLIST = new Map<string, string>([
  // NSIS 安装器刻意显示进度窗口：静默换装本机实测 10.5 分钟零 UI，用户误以为
  // 更新卡死（R86，见 app-updater.ts spawn 安装器处的弃用 /S 注释），进度可见
  // 是产品决策而非疏漏
  ["app-updater.ts", "安装器刻意显示进度窗口（R86：静默换装无可感知进度）"],
]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

describe("windowsHide 回归守卫", () => {
  test("allowlist 每条豁免都必须注释原因且目标文件存在", () => {
    for (const [file, reason] of ALLOWLIST) {
      expect(reason.trim().length, `${file} 缺豁免原因说明`).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(SRC_DIR, file)), `${file} 豁免目标不存在`).toBe(true);
    }
  });

  test("控制台子系统程序调用点 600 字符窗口内必须含 windowsHide", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, file);
      if (ALLOWLIST.has(rel)) continue;
      const content = fs.readFileSync(file, "utf-8");
      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL_RE.exec(content)) !== null) {
        const window = content.slice(m.index, m.index + WINDOW_CHARS);
        if (!CONSOLE_PROGRAM_RE.test(window)) continue;
        if (window.includes("windowsHide")) continue;
        const line = content.slice(0, m.index).split("\n").length;
        violations.push(`${rel}:${line}（${m[1]} 调用命中控制台程序但缺 windowsHide）`);
      }
    }
    expect(violations).toEqual([]);
  });
});
