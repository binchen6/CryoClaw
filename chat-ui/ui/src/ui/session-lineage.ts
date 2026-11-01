import type { GatewaySessionRow } from "./types.ts";

export function collectSessionLineageKeys(
  sessions: readonly GatewaySessionRow[],
  rootKey: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const row of sessions) {
    const parent = row.spawnedBy ?? row.controlOwnerSessionKey;
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(row.key);
    children.set(parent, list);
  }
  const out: string[] = [];
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visited.has(key)) return;
    visited.add(key);
    out.push(key);
    for (const child of children.get(key) ?? []) visit(child);
  };
  visit(rootKey);
  return out;
}

export function hasActiveSessionRun(row: GatewaySessionRow | undefined): boolean {
  return Boolean(
    row && (
      row.hasActiveRun === true ||
      row.hasActiveSubagentRun === true ||
      (row.activeRunIds?.length ?? 0) > 0 ||
      row.status === "queued" ||
      row.status === "running"
    ),
  );
}

export function findActiveLineageSessions(
  sessions: readonly GatewaySessionRow[],
  rootKey: string,
): GatewaySessionRow[] {
  const keys = new Set(collectSessionLineageKeys(sessions, rootKey));
  return sessions.filter((row) => keys.has(row.key) && hasActiveSessionRun(row));
}
