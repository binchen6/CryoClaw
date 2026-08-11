import test from "node:test";
import assert from "node:assert/strict";
import { filterCommands, resolveCommandDescription } from "./commands.ts";
import { setLocale } from "../i18n.ts";
import type { CommandEntry } from "../types.ts";

function cmd(name: string, overrides: Partial<CommandEntry> = {}): CommandEntry {
  return { name, description: `English desc for ${name}`, acceptsArgs: true, ...overrides };
}

test("filterCommands：空查询返回前 limit 条", () => {
  const commands = [cmd("goal"), cmd("think"), cmd("fast")];
  assert.deepEqual(
    filterCommands(commands, "", 2).map((c) => c.name),
    ["goal", "think"],
  );
});

test("filterCommands：前缀匹配优先于包含匹配", () => {
  const commands = [cmd("new"), cmd("goal"), cmd("go"), cmd("think"), cmd("newnote")];
  const result = filterCommands(commands, "go");
  assert.deepEqual(
    result.map((c) => c.name),
    ["goal", "go"],
  );
});

test("filterCommands：textAliases 参与匹配，大小写不敏感，limit 截断", () => {
  const commands = [cmd("Goal", { textAliases: ["target"] }), cmd("think"), cmd("go")];
  assert.deepEqual(
    filterCommands(commands, "TARGET").map((c) => c.name),
    ["Goal"],
  );
  const many = Array.from({ length: 20 }, (_, i) => cmd(`cmd${i}`));
  assert.equal(filterCommands(many, "cmd", 8).length, 8);
});

test("resolveCommandDescription：中文界面下收录的命令返回中文描述", () => {
  setLocale("zh");
  assert.equal(resolveCommandDescription(cmd("goal")), "设置/管理会话目标（开始、暂停、恢复、清除）");
  assert.equal(resolveCommandDescription(cmd("think")), "调整思考强度（think hard / think harder 等）");
  assert.equal(resolveCommandDescription(cmd("plan")), "进入计划模式（先规划后执行）");
});

test("resolveCommandDescription：中文界面下未收录命令回退内核英文描述", () => {
  setLocale("zh");
  const c = cmd("customcmd");
  assert.equal(resolveCommandDescription(c), "English desc for customcmd");
});

test("resolveCommandDescription：英文界面下优先内核英文描述", () => {
  setLocale("en");
  try {
    // 收录命令也应显示英文
    assert.equal(resolveCommandDescription(cmd("goal")), "English desc for goal");
    // 内核无英文描述时才回退中文映射（模拟内核缺失 description 的运行时数据）
    const noDesc = { name: "goal", acceptsArgs: true } as unknown as CommandEntry;
    assert.equal(resolveCommandDescription(noDesc), "设置/管理会话目标（开始、暂停、恢复、清除）");
  } finally {
    setLocale("zh");
  }
});
