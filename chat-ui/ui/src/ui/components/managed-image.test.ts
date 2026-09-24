import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// managed-image.ts 的失败重试依赖真实 DOM 事件流，node 环境做源码审计钉住接线，
// 防止回退为「失败后必须整页刷新」（托管图片鉴权回退修复后，历史图片点击即可恢复）。
function readSource(): string {
  const fromSource = new URL("./managed-image.ts", import.meta.url);
  const fromDist = new URL("../../../../../src/ui/components/managed-image.ts", import.meta.url);
  return readFileSync(existsSync(fromSource) ? fromSource : fromDist, "utf8");
}

test("managed-image：失败占位可点击重试（键盘可达 + i18n 提示）", () => {
  const s = readSource();
  assert.match(s, /placeholder--retry/, "失败占位应有可点击样式类");
  assert.match(
    s,
    /@click=\$\{\(\) => this\.retry\(\)\}/,
    "失败占位点击应触发 retry（重新走鉴权回退链，失败无负缓存）",
  );
  assert.match(
    s,
    /if \(e\.key === "Enter" \|\| e\.key === " "\) \{ e\.preventDefault\(\); this\.retry\(\); \}/,
    "失败占位应键盘可达（Enter/Space 重试）",
  );
  assert.match(s, /t\("chat\.mediaRetry"\)/, "重试提示应走 i18n（chat.mediaRetry）");
});

test("managed-image：鉴权候选顺序（共享 token 优先）由 managed-media 回退链承担", () => {
  const s = readSource();
  assert.ok(
    s.includes("fetchManagedImageObjectUrl"),
    "托管图片仍应经 fetchManagedImageObjectUrl（内部含候选凭证回退）",
  );
  const media = readFileSync(
    existsSync(new URL("./managed-media.ts", import.meta.url))
      ? new URL("./managed-media.ts", import.meta.url)
      : new URL("../../../../../src/ui/chat/managed-media.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    media.indexOf("push(config?.sharedToken)") < media.indexOf('role: "operator"'),
    "候选序列应共享 token 优先（HTTP 媒体端点拒绝设备 token，实测 401）",
  );
});
