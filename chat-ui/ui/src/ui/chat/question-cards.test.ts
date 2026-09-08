import test from "node:test";
import assert from "node:assert/strict";
import {
  applyQuestionResolution,
  buildResolveParams,
  isTappableQuestion,
  normalizeQuestionItem,
  normalizeQuestionRecord,
  normalizeQuestionResolution,
  pruneExpiredQuestions,
  reconcileQuestionsFromList,
  selectPendingQuestions,
  upsertQuestion,
  type QuestionPrompt,
} from "./question-cards.ts";

function pendingRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "q-1",
    status: "pending",
    questions: [
      {
        questionId: "target",
        header: "Target",
        question: "Which file?",
        options: [{ label: "A.ts" }, { label: "B.ts", description: "the other" }],
      },
    ],
    sessionKey: "agent:main:main",
    createdAtMs: 1000,
    expiresAtMs: 99999,
    ...over,
  };
}

test("normalizeQuestionItem：合法项归一 + 布尔缺省 false", () => {
  const item = normalizeQuestionItem((pendingRecord().questions as Array<unknown>)[0]);
  assert.ok(item);
  assert.equal(item!.questionId, "target");
  assert.equal(item!.multiSelect, false);
  assert.equal(item!.isSecret, false);
  assert.deepEqual(item!.options[1], { label: "B.ts", description: "the other" });
});

test("normalizeQuestionItem：非法 questionId / 越界选项数 / 坏类型 → null", () => {
  const base = (pendingRecord().questions as Array<Record<string, unknown>>)[0];
  assert.equal(normalizeQuestionItem({ ...base, questionId: "Bad-Id" }), null);
  assert.equal(normalizeQuestionItem({ ...base, questionId: "1abc" }), null);
  assert.equal(normalizeQuestionItem({ ...base, options: [] }), null);
  assert.equal(
    normalizeQuestionItem({ ...base, options: [1, 2, 3, 4, 5].map((i) => ({ label: String(i) })) }),
    null,
  );
  assert.equal(normalizeQuestionItem({ ...base, multiSelect: "yes" }), null);
  assert.equal(normalizeQuestionItem({ ...base, header: 42 }), null);
  assert.equal(normalizeQuestionItem({ ...base, secretStore: { kind: "other" } }), null);
});

test("normalizeQuestionRecord：完整 pending 记录归一；数量/重复/状态校验", () => {
  const rec = normalizeQuestionRecord(pendingRecord());
  assert.ok(rec);
  assert.equal(rec!.status, "pending");
  assert.equal(rec!.sessionKey, "agent:main:main");
  assert.equal(normalizeQuestionRecord(pendingRecord({ questions: [] })), null);
  assert.equal(normalizeQuestionRecord(pendingRecord({ status: "weird" })), null);
  assert.equal(normalizeQuestionRecord(pendingRecord({ expiresAtMs: "soon" })), null);
  // 重复 questionId 拒绝
  const dupQ = (pendingRecord().questions as Array<unknown>)[0];
  const dup = pendingRecord({ questions: [dupQ, dupQ] });
  assert.equal(normalizeQuestionRecord(dup), null);
});

test("selectPendingQuestions：会话过滤 + 全局问题可见 + 过期剔除", () => {
  const now = 5000;
  const prompts: QuestionPrompt[] = [
    normalizeQuestionRecord(pendingRecord({ id: "a", sessionKey: "agent:main:main" }))!,
    normalizeQuestionRecord(pendingRecord({ id: "b", sessionKey: "agent:other:main" }))!,
    normalizeQuestionRecord(pendingRecord({ id: "c", sessionKey: undefined }))!,
    normalizeQuestionRecord(pendingRecord({ id: "d", expiresAtMs: 4000 }))!,
    normalizeQuestionRecord(pendingRecord({ id: "e", status: "answered" }))!,
  ];
  const ids = selectPendingQuestions(prompts, "agent:main:main", now).map((p) => p.id);
  assert.deepEqual(ids, ["a", "c"]);
});

test("upsertQuestion：同 id 终态忽略、pending 替换、新 id 追加（纯更新）", () => {
  const original = normalizeQuestionRecord(pendingRecord())!;
  const answered = { ...original, status: "answered" as const };
  // 终态不被 pending 覆盖（返回原数组）
  const arr0 = upsertQuestion([answered], original);
  assert.equal(arr0[0].status, "answered", "终态不被 pending 覆盖");
  // pending 替换（同 id 更新）
  const v2 = { ...original, expiresAtMs: 123 };
  const arr2 = upsertQuestion([original], v2);
  assert.equal(arr2.length, 1);
  assert.equal(arr2[0].expiresAtMs, 123);
  // 新增
  const arr3 = upsertQuestion([], original);
  assert.equal(arr3.length, 1);
});

test("applyQuestionResolution：更新对应条目状态；未知 id 忽略", () => {
  const original = normalizeQuestionRecord(pendingRecord())!;
  const next = applyQuestionResolution([original], { id: "q-1", status: "cancelled" });
  assert.equal(next[0].status, "cancelled");
  assert.equal(applyQuestionResolution([], { id: "nope", status: "cancelled" }).length, 0);
});

test("normalizeQuestionResolution：状态白名单", () => {
  assert.deepEqual(normalizeQuestionResolution({ id: "x", status: "answered" }), { id: "x", status: "answered" });
  assert.equal(normalizeQuestionResolution({ id: "x", status: "weird" }), null);
  assert.equal(normalizeQuestionResolution({ status: "cancelled" }), null);
});

test("reconcileQuestionsFromList：服务端终态收敛本地 pending，本地终态保持", () => {
  const localPending = normalizeQuestionRecord(pendingRecord({ id: "q1" }))!;
  const localAnswered = normalizeQuestionRecord(pendingRecord({ id: "q2" }))!;
  const local = [
    localPending,
    { ...localAnswered, status: "answered" as const },
  ];
  const server = [
    normalizeQuestionRecord(pendingRecord({ id: "q1", status: "cancelled" }))!,
    normalizeQuestionRecord(pendingRecord({ id: "q2", status: "pending" }))!,
    normalizeQuestionRecord(pendingRecord({ id: "q3" }))!,
  ];
  const merged = reconcileQuestionsFromList(local, server);
  const byId = new Map(merged.map((p) => [p.id, p.status]));
  assert.equal(byId.get("q1"), "cancelled", "服务端终态收敛本地 pending");
  assert.equal(byId.get("q2"), "answered", "本地终态不被服务端 pending 覆盖");
  assert.equal(byId.get("q3"), "pending", "服务端新条目并入");
});

test("pruneExpiredQuestions：过期 pending 标 expired，未过期不动（引用保持）", () => {
  const p1 = normalizeQuestionRecord(pendingRecord({ id: "p1", expiresAtMs: 1000 }))!;
  const p2 = normalizeQuestionRecord(pendingRecord({ id: "p2", expiresAtMs: 9000 }))!;
  const next = pruneExpiredQuestions([p1, p2], 5000);
  assert.equal(next[0].status, "expired");
  assert.equal(next[1], p2, "未过期条目引用不变");
  const again = pruneExpiredQuestions(next, 5000);
  assert.equal(again, next, "无变化时返回原数组");
});

test("buildResolveParams：cancel / 常规回答 / secret 走 stored + allowedHosts", () => {
  const plain = normalizeQuestionRecord(pendingRecord())!;
  assert.deepEqual(buildResolveParams(plain, null), { id: "q-1", cancel: true });
  assert.deepEqual(buildResolveParams(plain, { target: ["A.ts"] }), {
    id: "q-1",
    answers: { target: ["A.ts"] },
  });
  const secret = normalizeQuestionRecord(
    pendingRecord({
      questions: [
        {
          questionId: "api_key",
          header: "Key",
          question: "Use stored key?",
          options: [{ label: "Use stored" }],
          secretStore: { kind: "secret", allowedHosts: ["api.example.com"] },
        },
      ],
    }),
  )!;
  assert.deepEqual(buildResolveParams(secret, { api_key: ["Use stored"] }), {
    id: "q-1",
    answers: { api_key: ["stored"] },
    secretStoreAllowedHosts: ["api.example.com"],
  });
});

test("isTappableQuestion：单问题+非多选+非 secret 才可按钮直答", () => {
  const plain = normalizeQuestionRecord(pendingRecord())!;
  assert.equal(isTappableQuestion(plain), true);
  const multi = normalizeQuestionRecord(
    pendingRecord({ questions: [{ ...((pendingRecord().questions as Array<Record<string, unknown>>)[0]), multiSelect: true }] }),
  )!;
  assert.equal(isTappableQuestion(multi), false);
  const secret = normalizeQuestionRecord(
    pendingRecord({
      questions: [
        {
          questionId: "k",
          header: "K",
          question: "?",
          options: [{ label: "ok" }],
          secretStore: { kind: "secret" },
        },
      ],
    }),
  )!;
  assert.equal(isTappableQuestion(secret), false);
});
