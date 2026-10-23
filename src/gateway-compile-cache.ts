import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Match OpenClaw node-compile-cache.mjs before spawning, so its launcher keeps
 * the gateway in the IPC-owned process. Cache failure must never block startup. */
export function gatewayCompileCacheDirectory(packageRoot: string, base: string): string {
  try {
    const manifestPath = path.join(packageRoot, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const sanitize = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    let version = typeof manifest.version === "string" ? sanitize(manifest.version) : "unknown";
    if (!version || version === "." || version === "..") version = "unknown";
    const stat = fs.statSync(manifestPath);
    let marker = `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
    try {
      const build = JSON.parse(fs.readFileSync(path.join(packageRoot, "dist", "build-info.json"), "utf8"));
      if (typeof build.buildId === "string" && build.buildId.trim()) marker = createHash("sha256").update(build.buildId).digest("hex").slice(0, 16);
    } catch { /* Older kernels use package metadata. */ }
    const directory = path.resolve(base, "openclaw", version, marker);
    return process.platform === "win32" && directory.length > 200 ? base : directory;
  } catch { return base; }
}
