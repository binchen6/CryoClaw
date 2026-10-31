import type { ToolCard } from "../types/chat-types.ts";

export type ToolCodeSection = {
  title: string;
  text: string;
  language?: string;
  kind: "command" | "read" | "diff" | "output";
};

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return undefined;
}

/** Presentation only: never infer execution success or background process liveness. */
export function toolCodeSections(card: ToolCard, language?: string): ToolCodeSection[] {
  const args = card.args && typeof card.args === "object"
    ? card.args as Record<string, unknown> : {};
  const name = card.name.toLowerCase();
  const file = stringArg(args, "path", "file_path", "filePath") ?? "";
  if (["exec", "bash", "shell", "terminal", "code_execution"].includes(name)) {
    const command = stringArg(args, "command", "cmd", "script");
    const sections: ToolCodeSection[] = command ? [{ title: stringArg(args, "workdir", "cwd") ?? "Bash", text: command, language: "bash", kind: "command" }] : [];
    if (!card.pending && card.text?.trim()) sections.push({ title: "", text: card.text, kind: "output" });
    return sections;
  }
  if (name === "read" && !card.pending && card.text?.trim()) {
    return [{ title: file, text: card.text, language, kind: "read" }];
  }
  if (["edit", "apply_patch"].includes(name)) {
    // A requested edit is input, not proof that a write succeeded. The caller
    // labels it accordingly and keeps the real result/error visible separately.
    const before = stringArg(args, "old_string", "oldText", "old_text");
    const after = stringArg(args, "new_string", "newText", "new_text");
    if (before !== undefined || after !== undefined) {
      const lines = [
        ...(before !== undefined ? before.split(/\r?\n/).map(line => `- ${line}`) : []),
        ...(after !== undefined ? after.split(/\r?\n/).map(line => `+ ${line}`) : []),
      ];
      return [{ title: file, text: lines.join("\n"), language: "diff", kind: "diff" }];
    }
    const patch = stringArg(args, "patch", "input");
    if (patch) return [{ title: file, text: patch, language: "diff", kind: "diff" }];
  }
  return [];
}

/** Bound rendering work, retaining the original source for copy/full output. */
export function visibleToolCode(text: string, cap = 8_000): string {
  return text.length > cap ? text.slice(0, cap) + "\n…" : text;
}
