import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomicSync } from "./atomic-write";

export const PLUGIN_SNAPSHOT_CACHE_TTL_MS = 10 * 60_000;
export type PluginSnapshotKind = "channel-inventory" | "plugin-list";
type SnapshotEnvelope = { schema: 1; at: number; fingerprint: string; value: unknown };

function canonical(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function pluginSnapshotCachePath(stateDir: string, kind: PluginSnapshotKind): string {
  return path.join(stateDir, "cache", `cryoclaw-${kind}-v1.json`);
}

export function pluginSnapshotFingerprint(options: {
  packageDir: string;
  stateDir: string;
  config: unknown;
  extraEnv?: NodeJS.ProcessEnv;
  allowErrors?: boolean;
}): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(options.packageDir, "package.json"), "utf8")) as { version?: string };
  const env = Object.entries(options.extraEnv ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(canonical({
    schema: 1,
    kernelVersion: manifest.version ?? "",
    stateDir: path.resolve(options.stateDir).toLowerCase(),
    config: options.config,
    env,
    allowErrors: options.allowErrors === true,
  })).digest("hex");
}

export function readPluginSnapshotCache<T>(options: {
  stateDir: string;
  kind: PluginSnapshotKind;
  fingerprint: string;
  now?: number;
}): T | null {
  try {
    const envelope = JSON.parse(fs.readFileSync(pluginSnapshotCachePath(options.stateDir, options.kind), "utf8")) as SnapshotEnvelope;
    const age = (options.now ?? Date.now()) - envelope.at;
    if (envelope.schema !== 1 || envelope.fingerprint !== options.fingerprint ||
        age < 0 || age >= PLUGIN_SNAPSHOT_CACHE_TTL_MS || !Array.isArray(envelope.value)) return null;
    return envelope.value as T;
  } catch {
    return null;
  }
}

export function writePluginSnapshotCache(options: {
  stateDir: string;
  kind: PluginSnapshotKind;
  fingerprint: string;
  value: unknown;
}): void {
  const file = pluginSnapshotCachePath(options.stateDir, options.kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const envelope: SnapshotEnvelope = { schema: 1, at: Date.now(), fingerprint: options.fingerprint, value: options.value };
  writeFileAtomicSync(file, JSON.stringify(envelope));
}

export function invalidatePluginSnapshotCaches(stateDir: string): void {
  for (const kind of ["channel-inventory", "plugin-list"] as const) {
    const file = pluginSnapshotCachePath(stateDir, kind);
    try { fs.rmSync(file, { force: true }); } catch {}
    try { fs.rmSync(`${file}.tmp`, { force: true }); } catch {}
  }
}
