import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTranscriptMarkdown,
  buildTranscriptFilename,
  tryFetchKernelTranscript,
} from "./transcript-export.ts";

test("buildTranscriptMarkdown serializes roles, text blocks, timestamps and error/partial tags", () => {
  const md = buildTranscriptMarkdown(
    { key: "agent:main:main", label: "调试会话" },
    [
      {
        role: "user",
        content: [{ type: "text", text: "帮我看看布局" }],
        timestamp: 1_757_136_000_000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "好的，先跑诊断。" }, { type: "tool_use", id: "x" }],
        timestamp: 1_757_136_010_000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: provider failed" }],
        timestamp: 1_757_136_020_000,
        cryoclawError: true,
      },
      { role: "assistant", content: [] },
    ],
    1_757_145_600_000,
  );
  assert.match(md, /^# 调试会话$/m);
  assert.match(md, /- Session: `agent:main:main`/);
  assert.match(md, /- Messages: 4/);
  const day1 = new Date(1_757_136_000_000).toISOString().slice(0, 10);
  assert.match(md, new RegExp("## user · " + day1));
  assert.match(md, /## assistant `error`/);
  assert.ok(!md.includes("tool_use"), "非文本块（tool_use）不得进入转录正文");
  assert.ok(!md.includes("## assistant\n"), "空文本消息不产生空段落");
  // 空段过滤后不应留下孤立的 "---" 连接符
  assert.ok(!/\n\n---\n\n\n/.test(md));
});

test("buildTranscriptMarkdown falls back to key when label missing and string content passes through", () => {
  const md = buildTranscriptMarkdown({ key: "s1" }, [
    { role: "user", content: "纯字符串内容" },
  ]);
  assert.match(md, /^# s1$/m);
  assert.match(md, /纯字符串内容/);
});

test("buildTranscriptFilename sanitizes separators and caps length", () => {
  const name = buildTranscriptFilename("周报: 09/06 *final*", "agent:main", new Date("2026-09-06T00:00:00Z"));
  assert.ok(name.startsWith("transcript-"));
  assert.ok(name.endsWith("-2026-09-06.md"));
  assert.ok(!/[\\/:*?"<>|\s]/.test(name), "文件名不得含非法字符: " + name);
  const long = buildTranscriptFilename("x".repeat(200), "k", new Date("2026-09-06T00:00:00Z"));
  assert.ok(long.length < 100, "超长标签截断: " + long.length);
});

test("tryFetchKernelTranscript returns null on method-not-found (2026.8.2 fallback path)", async () => {
  const client = {
    request: async () => {
      throw new Error("Method not found: transcripts.get");
    },
  } as unknown as Parameters<typeof tryFetchKernelTranscript>[0];
  assert.equal(await tryFetchKernelTranscript(client, "s1"), null);
});

test("tryFetchKernelTranscript returns kernel markdown when available (2026.9.2 path)", async () => {
  const client = {
    request: async (_method: string, _params: unknown) => ({ transcript: "# kernel transcript" }),
  } as unknown as Parameters<typeof tryFetchKernelTranscript>[0];
  assert.equal(await tryFetchKernelTranscript(client, "s1"), "# kernel transcript");
});
