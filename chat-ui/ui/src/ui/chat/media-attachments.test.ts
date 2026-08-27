// media-attachments.test.ts — 已发送附件元数据提取/文件名还原（纯函数）
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractMessageMediaAttachments,
  isImageMime,
  mediaPathBaseName,
  restoreMediaFileName,
} from "./media-attachments.ts";

test("restoreMediaFileName: 剥掉内核 media store 的 ---<uuid> 段", () => {
  assert.equal(
    restoreMediaFileName("report---3f2c1a4e-5b6c-4d7e-8f9a-0b1c2d3e4f5a.pdf"),
    "report.pdf",
  );
  // 无扩展名也剥
  assert.equal(
    restoreMediaFileName("data---3f2c1a4e-5b6c-4d7e-8f9a-0b1c2d3e4f5a"),
    "data",
  );
  // 大写 hex
  assert.equal(
    restoreMediaFileName("a---3F2C1A4E-5B6C-4D7E-8F9A-0B1C2D3E4F5A.PNG"),
    "a.PNG",
  );
});

test("restoreMediaFileName: 普通文件名原样保留", () => {
  assert.equal(restoreMediaFileName("报告 最终版.docx"), "报告 最终版.docx");
  // 形似但非 uuid（长度/段数不符）不动
  assert.equal(restoreMediaFileName("a---deadbeef.png"), "a---deadbeef.png");
  assert.equal(restoreMediaFileName("a---b---c.txt"), "a---b---c.txt");
});

test("mediaPathBaseName: Windows / POSIX 路径分隔符", () => {
  assert.equal(mediaPathBaseName("C:\\Users\\u\\a.txt"), "a.txt");
  assert.equal(mediaPathBaseName("/home/u/a.txt"), "a.txt");
  assert.equal(mediaPathBaseName("a.txt"), "a.txt");
});

test("isImageMime: image/* 判定", () => {
  assert.equal(isImageMime("image/png"), true);
  assert.equal(isImageMime("Image/JPEG"), true);
  assert.equal(isImageMime("application/pdf"), false);
  assert.equal(isImageMime(undefined), false);
  assert.equal(isImageMime(""), false);
});

test("extractMessageMediaAttachments: 复数 MediaPaths/MediaTypes 平行对应", () => {
  const atts = extractMessageMediaAttachments({
    role: "user",
    MediaPaths: ["/media/inbound/a---3f2c1a4e-5b6c-4d7e-8f9a-0b1c2d3e4f5a.pdf", "C:\\x\\b.png"],
    MediaTypes: ["application/pdf", "image/png"],
  });
  assert.equal(atts.length, 2);
  assert.deepEqual(atts[0], {
    path: "/media/inbound/a---3f2c1a4e-5b6c-4d7e-8f9a-0b1c2d3e4f5a.pdf",
    mimeType: "application/pdf",
    fileName: "a.pdf",
  });
  assert.deepEqual(atts[1], { path: "C:\\x\\b.png", mimeType: "image/png", fileName: "b.png" });
});

test("extractMessageMediaAttachments: 兼容单数 MediaPath/MediaType", () => {
  const atts = extractMessageMediaAttachments({
    MediaPath: "/media/inbound/note.txt",
    MediaType: "text/plain",
  });
  assert.deepEqual(atts, [{ path: "/media/inbound/note.txt", mimeType: "text/plain", fileName: "note.txt" }]);
});

test("extractMessageMediaAttachments: 边界（空/缺字段/脏数据）", () => {
  assert.deepEqual(extractMessageMediaAttachments(null), []);
  assert.deepEqual(extractMessageMediaAttachments({ role: "user" }), []);
  // MediaTypes 缺项 → mimeType undefined；空串按缺失处理；非字符串路径跳过
  const atts = extractMessageMediaAttachments({
    MediaPaths: ["/a/b.zip", 42, "  "],
    MediaTypes: [""],
  });
  assert.deepEqual(atts, [{ path: "/a/b.zip", mimeType: undefined, fileName: "b.zip" }]);
});
