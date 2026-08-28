// 守护回归（源码审计，同 app-update-notify.test.ts / i18n.test.ts 模式）：
// P2「已发送文件附件卡片化」的 UI 接线。重 UI 模块（views/chat.ts、app.ts 等）
// 在 node 下不可导入，只能钉源码。
//
// 钉住的不变量：
// - controllers/chat.ts：文件附件走 readFileBase64 → apiAttachments type:"file"；
//   乐观气泡挂 MediaPaths/MediaTypes；失败错误卡带 resendAttachments；超限降级文本前缀
// - grouped-render.ts：消费 MediaPaths/MediaTypes（media-attachments.ts），
//   图片 file:// 直渲 + onerror 降级文件卡片，重发回调带附件
// - app-chat.ts：messageOverride 分支允许 opts.attachments（重发带附件）
// - app-chat-props.ts：onResendError 把附件带回 handleSendChat
// - ipc-bridge.ts：封装 readFileBase64
// - i18n：chat.fileCard.openLabel / chat.attachmentFallbackPath 双语齐全
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zhDict } from "./i18n/zh.ts";
import { enDict } from "./i18n/en.ts";

// 编译产物位于 chat-ui/ui/.test-dist/ui/src/ui/，源文件位于 chat-ui/ui/src/ui/
function src(rel: string): string {
  return readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8");
}

test("controllers/chat.ts：文件附件走 readFileBase64 → apiAttachments type:file", () => {
  const s = src("controllers/chat.ts");
  assert.match(s, /readFileBase64\(/, "应调用 readFileBase64 读本地文件");
  assert.match(s, /type:\s*"file"/, "apiAttachments 应含 type:\"file\" 条目");
  assert.match(s, /fileName:/, "文件附件应带 fileName");
  assert.match(s, /"base64" in res/, "应按 base64 字段判定成功/超限结构");
});

test("controllers/chat.ts：乐观气泡挂 MediaPaths/MediaTypes（仅成功编码文件，与 history 同构）", () => {
  const s = src("controllers/chat.ts");
  assert.match(s, /MediaPaths:\s*\[\.\.\.echoMediaPaths\]/, "乐观气泡应挂 MediaPaths（仅成功编码文件）");
  assert.match(s, /MediaTypes:\s*\[\.\.\.echoMediaTypes\]/, "乐观气泡应挂平行 MediaTypes");
});

test("controllers/chat.ts：超限/读取失败降级文本前缀且 toast 提示", () => {
  const s = src("controllers/chat.ts");
  assert.match(s, /degradedFilePaths/, "应有降级路径集合");
  assert.match(s, /degradedFilePaths\.join\("\\n"\)\s*\+\s*"\\n\\n"/, "降级仍走文本前缀");
  assert.match(s, /t\("chat\.attachmentFallbackPath"\)/, "降级应有 toast 提示文案");
});

test("controllers/chat.ts：失败错误卡带 resendAttachments（重发不丢附件）", () => {
  const s = src("controllers/chat.ts");
  assert.match(s, /resendAttachments:/, "错误卡应保存 resendAttachments");
  assert.match(s, /!degradedFilePaths\.includes/, "已降级进文本前缀的文件不应重复带回");
});

test("grouped-render.ts：消费 MediaPaths/MediaTypes 渲染附件卡片", () => {
  const s = src("chat/grouped-render.ts");
  assert.match(s, /extractMessageMediaAttachments\(message\)/, "应提取顶层媒体附件元数据");
  assert.match(s, /buildFileCardHtml\(att\.path, att\.fileName\)/, "文件应渲染文件卡片");
  assert.match(s, /localPathToFileUrl\(att\.path\)/, "图片应 file:// 直渲");
  assert.match(s, /chat-attachment-image/, "图片附件应使用专用 class");
  assert.match(s, /degradeMediaImageToFileCard/, "图片加载失败应降级为文件卡片");
  assert.match(s, /chatMediaEnhanceRef/, "附件容器应挂 ref 安装点击委托");
  assert.match(
    s,
    /!markdown && !hasToolCards && !hasImages && !hasMediaAttachments/,
    "纯附件消息（无文本）不应被早退丢弃",
  );
});

test("grouped-render.ts：错误卡重发回调带回 resendAttachments", () => {
  const s = src("chat/grouped-render.ts");
  assert.match(s, /m\.resendAttachments/, "应读取错误卡上的 resendAttachments");
  assert.match(s, /onResendError\?\.\(resendText, resendAttachments\)/, "重发应带回附件");
});

test("app-chat.ts：messageOverride 分支允许 opts.attachments（重发带附件）", () => {
  const s = src("app-chat.ts");
  assert.match(
    s,
    /messageOverride == null \? attachments : \(opts\?\.attachments \?\? \[\]\)/,
    "重发分支应使用 opts.attachments 而非固定空数组",
  );
});

test("app-chat-props.ts：onResendError 把附件带回 handleSendChat", () => {
  const s = src("app-chat-props.ts");
  assert.match(s, /onResendError: \(text: string, attachments\?: ChatAttachment\[\]\)/, "签名应扩展附件参数");
  assert.match(s, /handleSendChat\(\s*text,/, "重发应把附件传给 handleSendChat");
});

test("ipc-bridge.ts：封装 readFileBase64", () => {
  const s = src("data/ipc-bridge.ts");
  assert.match(s, /export async function readFileBase64\(path: string\)/, "应有 readFileBase64 封装");
  assert.match(s, /readFileBase64\?: \(path: string\)/, "桥类型应声明 readFileBase64");
});

test("i18n：附件卡片新文案 zh/en 双语齐全", () => {
  for (const key of ["chat.fileCard.openLabel", "chat.attachmentFallbackPath"]) {
    assert.ok(zhDict[key], `zh 缺 ${key}`);
    assert.ok(enDict[key], `en 缺 ${key}`);
  }
});

test("chat.css：附件区样式 token 化且文件卡片样式复用", () => {
  const s = readFileSync(new URL("../../../../src/styles/chat.css", import.meta.url), "utf8");
  assert.match(s, /\.chat-message-attachments/, "应有附件容器样式");
  assert.match(s, /\.chat-attachment-image/, "应有图片附件样式");
  assert.match(s, /:is\(\.chat-text, \.chat-message-attachments\) \.chat-file-card/, "文件卡片样式应扩到附件容器");
  // 禁止硬编码 hex（token 化约束）
  const block = s.match(/\.chat-message-attachments[\s\S]*?\.chat-attachment-image \{[\s\S]*?\n\}/);
  assert.ok(block, "应能定位附件样式块");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block[0]), "附件样式块不得硬编码 hex 颜色");
});

test("media-enhance.ts：附件图片与 MEDIA: 图片共享 lightbox 预览委托", () => {
  const s = readFileSync(new URL("../../../../src/ui/chat/media-enhance.ts", import.meta.url), "utf8");
  assert.match(
    s,
    /closest\("img\.chat-local-media, img\.chat-attachment-image"\)/,
    "点击委托应同时覆盖 chat-local-media 与 chat-attachment-image",
  );
});
