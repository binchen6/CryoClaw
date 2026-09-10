import assert from "node:assert/strict";
import test from "node:test";
import { selectVisibleInstalledSkills } from "./skill-visibility.ts";
import type { SkillStatusEntry } from "./types.ts";

function skill(over: Partial<SkillStatusEntry>): SkillStatusEntry {
  return { skillKey: over.skillKey ?? "k", source: over.source ?? "local", ...over } as SkillStatusEntry;
}

// R66：计数徽章此前用原始报告长度，列表却按 eligible/搜索过滤 → "58 项"只渲染 2 行。

test("过滤被阻止项：eligible=false 不计入列表与计数", () => {
  const state = {
    skillsReport: {
      skills: [
        skill({ skillKey: "a", name: "Alpha" }),
        skill({ skillKey: "b", name: "Blocked", eligible: false }),
      ],
    },
    skillsFilter: "",
  };
  const visible = selectVisibleInstalledSkills(state);
  assert.deepEqual(visible.map((s) => s.skillKey), ["a"]);
});

test("搜索词同时收窄列表与计数（大小写不敏感、匹配 name/description/source）", () => {
  const state = {
    skillsReport: {
      skills: [
        skill({ skillKey: "a", name: "Alpha", description: "docx" }),
        skill({ skillKey: "b", name: "Beta", description: "pptx" }),
        skill({ skillKey: "c", name: "Gamma", source: "clawhub" }),
      ],
    },
    skillsFilter: "PPT",
  };
  assert.deepEqual(selectVisibleInstalledSkills(state).map((s) => s.skillKey), ["b"]);
});

test("无报告 / 空过滤：返回空数组或全部可见项，不抛错", () => {
  assert.deepEqual(selectVisibleInstalledSkills({ skillsReport: null, skillsFilter: "" }), []);
  assert.deepEqual(selectVisibleInstalledSkills({ skillsFilter: null }), []);
  const all = selectVisibleInstalledSkills({
    skillsReport: { skills: [skill({ skillKey: "a" }), skill({ skillKey: "b" })] },
    skillsFilter: "   ",
  });
  assert.equal(all.length, 2);
});
