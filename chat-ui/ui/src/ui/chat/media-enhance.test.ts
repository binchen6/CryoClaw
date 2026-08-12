import test from "node:test";
import assert from "node:assert/strict";

import { extractMediaMatch, localPathToFileUrl, looksLikeImagePath, renderMediaMarkers } from "./media-enhance.ts";

// ── 历史消息 MEDIA:<路径> 识别与 file URL 转换 ──

test("media：Windows 裸路径识别", () => {
  const m = extractMediaMatch("历史图片 MEDIA:C:\\Users\\demo\\pic.png 如下");
  assert.ok(m, "应匹配 MEDIA 标记");
  assert.equal(m!.path, "C:\\Users\\demo\\pic.png");
  assert.ok(m!.full.startsWith("MEDIA:"));
});

test("media：带引号路径识别", () => {
  const m = extractMediaMatch('MEDIA:"C:\\my files\\shot 1.png"');
  assert.ok(m, "应匹配带引号路径");
  assert.equal(m!.path, "C:\\my files\\shot 1.png");
});

test("media：非图片候选不误判", () => {
  // 裸词无分隔符且无图片扩展名 → 拒绝
  assert.equal(extractMediaMatch("MEDIA:hello"), null);
  // 无 MEDIA 标记
  assert.equal(extractMediaMatch("普通文本，没有标记"), null);
});

test("media：路径形态判断", () => {
  assert.equal(looksLikeImagePath("C:\\a\\b.png"), true);
  assert.equal(looksLikeImagePath("/tmp/x.jpg"), true);
  assert.equal(looksLikeImagePath("photo.jpeg"), true, "仅扩展名也算图片路径");
  assert.equal(looksLikeImagePath("hello"), false);
});

test("media：Windows 路径转 file URL", () => {
  assert.equal(
    localPathToFileUrl("C:\\Users\\demo\\pic.png"),
    "file:///C:/Users/demo/pic.png",
  );
  // 空格/中文编码
  assert.equal(
    localPathToFileUrl("D:\\我的 图片\\a.png"),
    "file:///D:/" + encodeURIComponent("我的 图片") + "/a.png",
  );
});

test("media：Unix 路径与不可解析路径", () => {
  assert.equal(localPathToFileUrl("/tmp/a b.png"), "file:///tmp/a%20b.png");
  assert.equal(localPathToFileUrl("~/a.png"), null, "~ 路径不解析");
  assert.equal(localPathToFileUrl("rel/a.png"), null, "相对路径不解析");
});

test("media：renderMediaMarkers 字符串层替换", () => {
  const html = renderMediaMarkers("<p>图片 MEDIA:C:\\demo\\pic.png 结束</p>");
  assert.ok(html.includes('<img class="chat-local-media"'), "应注入 img 标签");
  assert.ok(html.includes("file:///C:/demo/pic.png"), "src 应为 file URL");
  assert.ok(html.includes("data-media-text="), "应携带原始标记供失败回退");
});

test("media：renderMediaMarkers 代码块内与无效标记不替换", () => {
  const inPre = renderMediaMarkers("<pre><code>MEDIA:C:\\x\\y.png</code></pre>");
  assert.ok(!inPre.includes("<img"), "pre 内不渲染");
  const invalid = renderMediaMarkers("<p>MEDIA:hello</p>");
  assert.equal(invalid, "<p>MEDIA:hello</p>", "非路径候选保留原文");
  const none = renderMediaMarkers("<p>普通文本</p>");
  assert.equal(none, "<p>普通文本</p>");
});
