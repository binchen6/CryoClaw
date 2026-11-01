export type ChatShortcut = "new-session" | "focus-composer";
export type ShortcutId =
  | "newSession" | "focusComposer" | "send" | "newline" | "complete" | "saveFile" | "findFile"
  | "dockChanges" | "dockBrowser" | "dockTerminal" | "dockFiles" | "dockSubagent";

export type ShortcutDefinition = { id: ShortcutId; binding: string };
type ShortcutEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "keyCode" | "defaultPrevented">;
type Chord = { key: string; mod: "none" | "ctrl" | "mod"; alt: boolean; shift: boolean };

export const BUILTIN_SHORTCUTS: readonly ShortcutDefinition[] = [
  { id: "newSession", binding: "Ctrl+N" },
  { id: "focusComposer", binding: "Ctrl+L" },
  { id: "send", binding: "Mod+Enter" },
  { id: "newline", binding: "Enter" },
  { id: "complete", binding: "Tab" },
  { id: "saveFile", binding: "Mod+S" },
  { id: "findFile", binding: "Mod+F" },
  { id: "dockChanges", binding: "Ctrl+Shift+G" },
  { id: "dockBrowser", binding: "Ctrl+T" },
  { id: "dockTerminal", binding: "Ctrl+`" },
  { id: "dockFiles", binding: "Ctrl+Shift+E" },
  { id: "dockSubagent", binding: "Ctrl+Alt+B" },
] as const;

export const FIXED_SHORTCUTS = [
  { id: "escape", keys: ["Esc"] },
  { id: "arrowNavigation", keys: ["↑", "↓", "←", "→"] },
  { id: "tabNavigation", keys: ["Tab", "Shift", "Tab"] },
  { id: "homeEnd", keys: ["Home", "End"] },
] as const;

let overrides: Partial<Record<ShortcutId, string>> = {};

function defaultBinding(id: ShortcutId): string {
  return BUILTIN_SHORTCUTS.find(row => row.id === id)?.binding ?? "";
}

function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "Esc") return "Escape";
  if (key.length === 1 && /[a-z]/i.test(key)) return key.toUpperCase();
  return key;
}

function parseChord(binding: string): Chord | null {
  const parts = binding.split("+").map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const chord: Chord = { key: "", mod: "none", alt: false, shift: false };
  for (const part of parts) {
    if (part === "Mod" || part === "Ctrl") {
      const modifier = part === "Mod" ? "mod" : "ctrl";
      if (chord.mod !== "none" && chord.mod !== modifier) return null;
      chord.mod = modifier;
    } else if (part === "Alt") chord.alt = true;
    else if (part === "Shift") chord.shift = true;
    else if (!chord.key) chord.key = normalizeKey(part);
    else return null;
  }
  if (!chord.key || ["Control", "Meta", "Alt", "Shift"].includes(chord.key)) return null;
  if (/^[\w]$/.test(chord.key) && chord.mod === "none" && !chord.alt && !chord.shift) return null;
  return chord;
}

export function isValidShortcutBinding(binding: string): boolean {
  return parseChord(binding) !== null;
}

export function configureShortcuts(next: Partial<Record<string, string>> | undefined): void {
  overrides = {};
  for (const row of BUILTIN_SHORTCUTS) {
    const value = next?.[row.id];
    if (typeof value === "string" && (value === "" || isValidShortcutBinding(value))) overrides[row.id] = value;
  }
}

export function getShortcutBinding(id: ShortcutId): string {
  return Object.hasOwn(overrides, id) ? overrides[id]! : defaultBinding(id);
}

export function shortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  if (event.isComposing || event.keyCode === 229) return null;
  const key = normalizeKey(event.key);
  if (["Control", "Meta", "Alt", "Shift", "CapsLock", "NumLock"].includes(key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);
  const binding = parts.join("+");
  return isValidShortcutBinding(binding) ? binding : null;
}

export function formatShortcut(binding: string): string[] {
  if (!binding) return [];
  return binding.split("+").map(part => part === "Mod" ? "Ctrl / ⌘" : part === "Space" ? "Space" : part);
}

export function ariaShortcut(binding: string): string {
  return binding.replace(/Mod/g, "Control Meta");
}

export function matchesShortcut(event: ShortcutEvent, id: ShortcutId, modalOpen = false): boolean {
  const binding = getShortcutBinding(id);
  if (!binding || modalOpen || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return false;
  const chord = parseChord(binding);
  if (!chord) return false;
  const eitherModifier = event.ctrlKey || event.metaKey;
  const modifierMatches = chord.mod === "mod"
    ? eitherModifier
    : chord.mod === "ctrl"
      ? event.ctrlKey && !event.metaKey
      : !eitherModifier;
  return normalizeKey(event.key) === chord.key && modifierMatches && event.altKey === chord.alt && event.shiftKey === chord.shift;
}

export function resolveChatShortcut(event: ShortcutEvent, modalOpen = false): ChatShortcut | null {
  if (matchesShortcut(event, "newSession", modalOpen)) return "new-session";
  if (matchesShortcut(event, "focusComposer", modalOpen)) return "focus-composer";
  return null;
}

export function filterShortcuts<T extends {label: string; description: string; keys: readonly string[]}>(rows: readonly T[], query: string): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => {
    const text = `${row.label} ${row.description} ${row.keys.join(" ")}`.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}
