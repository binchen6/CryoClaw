import { extractToolCards } from "./tool-cards.ts";

export type CommandHistoryEntry = { key: string; command: string; output: string; pending: boolean; failed: boolean; exitCode?: number };
export type CommandHistoryFilter = "recent" | "running" | "finished" | "all";
export const COMMAND_PAGE_SIZE = 40;

/** A projection of the merged tool-stream messages, NOT an OS job registry. */
export function commandHistory(messages: readonly unknown[]): CommandHistoryEntry[] {
  const entries: CommandHistoryEntry[] = [];
  messages.forEach((message, index) => {
    if (!message || typeof message !== "object") return;
    const raw = message as Record<string, unknown>;
    const blocks = Array.isArray(raw.content) ? raw.content as Array<Record<string, unknown>> : [];
    const calls = blocks.filter(block => block && ["toolcall", "tool_call", "tooluse", "tool_use"].includes(String(block.type).toLowerCase()));
    for (const [cardIndex, card] of extractToolCards(message).entries()) {
      if (!["exec", "bash", "shell", "terminal", "code_execution"].includes(card.name.toLowerCase())) continue;
      const args = card.args && typeof card.args === "object" ? card.args as Record<string, unknown> : {};
      const command = [args.command, args.cmd, args.script].find(value => typeof value === "string") as string | undefined;
      if (!command?.trim()) continue;
      const block = calls[cardIndex];
      const id = block?.id ?? block?.toolCallId ?? block?.tool_call_id ?? raw.toolCallId ?? raw.id;
      entries.push({ key: id ? `${String(raw.runId ?? "")}:${String(id)}:${cardIndex}` : `${index}:${cardIndex}`,
        command, output: card.text ?? "", pending: card.pending === true,
        failed: card.error !== undefined || (card.exitCode !== undefined && card.exitCode !== 0), exitCode: card.exitCode });
    }
  });
  return entries.reverse();
}

export function filterCommandHistory(entries: readonly CommandHistoryEntry[], filter: CommandHistoryFilter): CommandHistoryEntry[] {
  if (filter === "recent") return entries.slice(0, 8);
  if (filter === "running") return entries.filter(entry => entry.pending);
  if (filter === "finished") return entries.filter(entry => !entry.pending);
  return [...entries];
}
