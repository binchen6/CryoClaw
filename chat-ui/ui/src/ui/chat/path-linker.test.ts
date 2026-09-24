import test from "node:test";
import assert from "node:assert/strict";

import { decodeHtmlEntities, linkifyPaths } from "./path-linker.ts";

// ── decodeHtmlEntities ──

test("decodeHtmlEntities：反转义 DOMPurify 标准命名实体", () => {
  assert.equal(decodeHtmlEntities("a&amp;b&lt;c&gt;d&quot;e"), 'a&b<c>d"e');
});

test("decodeHtmlEntities：数字实体覆盖 39（&#39; 与 &#x27; → 单引号）", () => {
  assert.equal(decodeHtmlEntities("&#39;"), "'");
  assert.equal(decodeHtmlEntities("&#x27;"), "'");
  assert.equal(decodeHtmlEntities("&#X27;"), "'");
});

test("decodeHtmlEntities：未知/畸形实体原样保留", () => {
  assert.equal(decodeHtmlEntities("&nbsp;"), "&nbsp;");
  assert.equal(decodeHtmlEntities("&notanentity;"), "&notanentity;");
  assert.equal(decodeHtmlEntities("a&b"), "a&b");
  assert.equal(decodeHtmlEntities("&#xZZ;"), "&#xZZ;");
  assert.equal(decodeHtmlEntities("&#99999999;"), "&#99999999;");
});

test("decodeHtmlEntities：无实体文本原样返回", () => {
  assert.equal(decodeHtmlEntities("/home/user/plain.txt"), "/home/user/plain.txt");
});

// ── linkifyPaths ──

function dataPathOf(html: string): string | null {
  const m = html.match(/data-path="([^"]*)"/);
  return m ? m[1] : null;
}

test("pathLinker：sanitize 后含 &amp; 的 Unix 路径完整匹配且只转义一次", () => {
  const out = linkifyPaths("<p>see /home/user/a&amp;b/file.txt</p>");
  assert.equal(dataPathOf(out), "/home/user/a&amp;b/file.txt", "data-path 应为单重转义的真实路径");
  assert.ok(!out.includes("&amp;amp"), "不得出现双重转义 &amp;amp");
  // 链接文本与 title 同步为真实路径（浏览器渲染 &amp; → &）
  assert.ok(out.includes(">/home/user/a&amp;b/file.txt</a>"), "链接文本应覆盖完整路径");
});

test("pathLinker：含 & 的 Windows 路径", () => {
  const out = linkifyPaths("<p>C:\\Users\\foo&amp;bar\\out.txt</p>");
  assert.equal(dataPathOf(out), "C:\\Users\\foo&amp;bar\\out.txt");
  assert.ok(!out.includes("&amp;amp"));
  assert.ok(out.includes(">C:\\Users\\foo&amp;bar\\out.txt</a>"));
});

test("pathLinker：不含特殊字符的路径行为不变", () => {
  const plain = "<p>see /home/user/plain.txt</p>";
  const out = linkifyPaths(plain);
  assert.equal(
    out,
    '<p>see <a class="chat-path-link" data-path="/home/user/plain.txt" ' +
      'title="/home/user/plain.txt" tabindex="0" role="button">/home/user/plain.txt</a></p>',
  );
});

test("pathLinker：链接键盘可达（tabindex/role，Enter/Space 由线程级 keydown 委托触发）", () => {
  const out = linkifyPaths("<p>/a/b/c.txt</p>");
  assert.ok(out.includes('tabindex="0"'), "无 href 的 <a> 需显式 tabindex 才能 Tab 聚焦");
  assert.ok(out.includes('role="button"'), "需补 button 角色，Enter/Space 语义对齐按钮");
});

test("pathLinker：多个 &amp; 实体的路径全部解码", () => {
  const out = linkifyPaths("<p>/a&amp;b/c&amp;d.txt</p>");
  assert.equal(dataPathOf(out), "/a&amp;b/c&amp;d.txt");
  assert.ok(!out.includes("&amp;amp"));
});

test("pathLinker：标签属性内的路径被守卫跳过", () => {
  const out = linkifyPaths('<img src="/a/b/c.txt" alt="/x/y/z.txt">');
  assert.ok(!out.includes("chat-path-link"), "属性内路径不应被链接化");
});

test("pathLinker：已有 <a> 内的路径被守卫跳过", () => {
  const out = linkifyPaths('<a href="https://example.com">/a/b/c.txt</a>');
  assert.ok(!out.includes("chat-path-link"));
});

test("pathLinker：紧跟协议 :// 之后的路径被守卫跳过", () => {
  // isPrecededByProtocol 契约：匹配起点紧邻 "://" 才跳过（如 scheme:///path）
  const out = linkifyPaths("<p>see http:///home/user/a.txt</p>");
  assert.ok(!out.includes("chat-path-link"), "协议后路径不应被链接化");
});

test("pathLinker：常规路径链接化行为不变", () => {
  const out = linkifyPaths("<p>/a/b/c.txt</p>");
  assert.equal(dataPathOf(out), "/a/b/c.txt");
});
