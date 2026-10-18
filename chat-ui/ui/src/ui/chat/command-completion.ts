import type { CommandEntry } from "../types.ts";
import { filterCommands, resolveCommandDescription } from "../controllers/commands.ts";

export type CommandSuggestion = { label: string; description: string; value: string; caret: number };

/** Complete only the token being edited. Never replace text after the caret or a selection. */
export function completeCommand(
  draft: string,
  caret: number,
  commands: CommandEntry[],
  models: Array<{ key: string; name: string }> = [],
): CommandSuggestion[] {
  if (!Number.isInteger(caret) || caret < 1 || caret > draft.length || /[\r\n]/.test(draft)) return [];
  const head = draft.slice(0, caret);
  const tail = draft.slice(caret);
  if (!/^[/／]/.test(head) || (tail && !/^\s/.test(tail))) return [];
  const root = /^[/／](\S*)$/.exec(head);
  const make = (label: string, description: string, prefix: string, token: string): CommandSuggestion => {
    const value = `${prefix}${token}${tail || " "}`;
    return { label, description, value, caret: prefix.length + token.length + (tail ? 0 : 1) };
  };
  if (root) return filterCommands(commands, root[1]).map(cmd => make(`/${cmd.name}`, resolveCommandDescription(cmd), "/", cmd.name));
  const args = /^[/／](\S+)\s+([^\r\n]*)$/.exec(head);
  if (!args) return [];
  const command = commands.find(cmd => [cmd.name, ...(cmd.textAliases ?? []).map(x => x.replace(/^\//, ""))].some(x => x.toLowerCase() === args[1].toLowerCase()));
  if (!command?.acceptsArgs) return [];
  const tokens = args[2].split(/\s+/);
  const query = tokens.pop() ?? "";
  const index = tokens.length;
  const arg = command.args?.[index];
  const choices: Array<{ value: string; label: string }> = [];
  if (Array.isArray(arg?.choices)) for (const choice of arg.choices) {
    if (typeof choice === "string") choices.push({ value: choice, label: choice });
    else if (choice && typeof choice.value === "string") choices.push({ value: choice.value, label: typeof choice.label === "string" ? choice.label : choice.value });
  }
  if (index === 0 && command.name === "model") for (const model of models) choices.push({ value: model.key, label: model.name });
  const seen = new Set<string>();
  return choices.filter(choice => {
    if (seen.has(choice.value) || !`${choice.value} ${choice.label}`.toLowerCase().includes(query.toLowerCase())) return false;
    seen.add(choice.value); return true;
  }).slice(0, 8).map(choice => make(choice.value, choice.label, head.slice(0, head.length - query.length), choice.value));
}
