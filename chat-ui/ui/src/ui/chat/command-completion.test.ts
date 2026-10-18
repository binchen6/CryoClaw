import test from "node:test";
import assert from "node:assert/strict";
import { completeCommand } from "./command-completion.ts";
import type { CommandEntry } from "../types.ts";
const commands: CommandEntry[] = [
  { name: "model", description: "Choose model", acceptsArgs: true },
  { name: "think", description: "Thinking", acceptsArgs: true, args: [{ name: "level", choices: [{ value: "high", label: "High" }, { value: "off", label: "Off" }] }] },
];
test("completion supports full width slash, native choices and configured model keys", () => {
  assert.equal(completeCommand("／mo", 3, commands)[0]?.value, "/model ");
  assert.equal(completeCommand("/think h", 8, commands)[0]?.value, "/think high ");
  assert.equal(completeCommand("/model flash", 12, commands, [{ key: "deepseek/flash", name: "Flash" }])[0]?.value, "/model deepseek/flash ");
});
test("completion preserves suffix and avoids multiline, middle of token and unrelated text", () => {
  assert.equal(completeCommand("/th later", 3, commands)[0]?.value, "/think later");
  for (const [draft, caret] of [["hi /th", 6], ["/think", 3], ["/th\nlater", 3], ["/think ", 0]] as const) assert.deepEqual(completeCommand(draft, caret, commands), []);
});
