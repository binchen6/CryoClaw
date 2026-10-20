import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (rel: string) =>
  readFileSync(new URL(`../../../../src/ui/${rel}`, import.meta.url), "utf8").replace(/\s+/g, " ");

// Enter during an active IME composition commits the candidate; it must not submit.
const GUARD = "if (e.isComposing || e.keyCode === 229) return;";

test("target/goal input ignores Enter while composing", () => {
  const src = source("views/chat-compose.ts");
  assert.ok(
    src.includes(`${GUARD} if (e.key === "Enter" && goalDraft.trim())`),
    "goal form must ignore the IME commit Enter",
  );
});

test("provider alias and group name inputs ignore Enter while composing", () => {
  const src = source("views/settings/tab-provider.ts");
  for (const action of ["handleOrgAdd(state)", "handleOrgRenameSave(state)", "handleAliasSave(prov, entry, state)"]) {
    assert.ok(
      src.includes(`${GUARD} if (e.key === "Enter") ${action}`),
      `${action} must ignore the IME commit Enter`,
    );
  }
});

test("session rename and workspace-create inputs ignore composition keys", () => {
  const src = source("components/oc-session-panel.ts");
  assert.ok(
    src.includes("if (ev.isComposing || ev.keyCode === 229) return; if (ev.key === \"Enter\")"),
    "session rename must ignore the IME commit Enter",
  );
  assert.ok(
    src.includes(`${GUARD} if (e.key === "Escape")`),
    "workspace-create dialog must ignore Enter/Escape while composing",
  );
});

test("memory recall and skill-store search ignore Enter while composing", () => {
  assert.ok(
    source("views/settings/tab-memory.ts").includes(`${GUARD} if (e.key === "Enter") handleRecallTest(state);`),
    "memory recall must ignore the IME commit Enter",
  );
  assert.ok(
    source("app-skills.ts").includes(`${GUARD} if (e.key === "Enter" && skillsSubTab === "store")`),
    "skill-store search must ignore the IME commit Enter",
  );
});
