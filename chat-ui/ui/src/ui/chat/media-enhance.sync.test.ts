// 白名单同步守卫：聊天 UI 侧 SAFE_OPEN_EXTS 副本（chat-ui/src/safe-open.ts）必须与
// 主进程唯一事实源（src/safe-open.ts）逐项一致。若本测试红灯，说明只改了一侧——
// 两侧漂移会导致「卡片能渲染但点击必失败」或「能打开但 UI 误降级为定位」（v2026.913.3）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SAFE_OPEN_EXTS as UI_SAFE_OPEN_EXTS } from "../../../../src/safe-open.ts";

// 仓库根定位：编译产物在 .test-dist/ui/src/ui/chat/ 下运行，源码路径深度不同，
// 直接数 ".." 会漂移；从测试文件位置向上找 name==="cryoclaw" 的 package.json。
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "cryoclaw") {
        return dir;
      }
    } catch {
      // 非 package.json 目录，继续向上
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("未能定位仓库根（cryoclaw package.json）");
}

test("SAFE_OPEN_EXTS UI 副本与主进程事实源一致", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = findRepoRoot(here);
  const mainSource = readFileSync(join(root, "src", "safe-open.ts"), "utf8");
  const block = mainSource.match(/SAFE_OPEN_EXTS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, "主进程 src/safe-open.ts 未找到 SAFE_OPEN_EXTS 数组");
  const mainExts = new Set(
    (block[1] ?? "").match(/"([a-z0-9]+)"/g)?.map((s) => s.slice(1, -1)) ?? [],
  );
  assert.ok(mainExts.size > 0, "主进程白名单解析为空");
  assert.deepEqual(
    [...UI_SAFE_OPEN_EXTS].sort(),
    [...mainExts].sort(),
    "两侧 SAFE_OPEN_EXTS 不一致：请同步 src/safe-open.ts 与 chat-ui/src/safe-open.ts",
  );
});
