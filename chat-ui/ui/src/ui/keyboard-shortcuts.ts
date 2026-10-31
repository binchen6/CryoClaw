export type ChatShortcut = "new-session" | "focus-composer";

type ShortcutEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "keyCode" | "defaultPrevented">;

/** Match only unclaimed, deliberate chat shortcuts; never interrupt IME or dialogs. */
export function resolveChatShortcut(event: ShortcutEvent, modalOpen = false): ChatShortcut | null {
  if (modalOpen || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat ||
      !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  switch (event.key.toLowerCase()) {
    case "n": return "new-session";
    case "l": return "focus-composer";
    default: return null;
  }
}

export const BUILTIN_SHORTCUTS = [
  {id: "newSession", keys: ["Ctrl", "N"]},
  {id: "focusComposer", keys: ["Ctrl", "L"]},
  {id: "send", keys: ["Ctrl / ⌘", "Enter"]},
  {id: "newline", keys: ["Enter"]},
  {id: "complete", keys: ["Tab"]},
  {id: "saveFile", keys: ["Ctrl / ⌘", "S"]},
  {id: "findFile", keys: ["Ctrl / ⌘", "F"]},
] as const;

export function filterShortcuts<T extends {label: string; description: string; keys: readonly string[]}>(rows: readonly T[], query: string): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => {
    const text = `${row.label} ${row.description} ${row.keys.join(" ")}`.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}
