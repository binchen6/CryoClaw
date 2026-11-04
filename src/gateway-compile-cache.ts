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

/** Enter the kernel's reviewed foreground bootstrap directly. Node must start
 * with its main-isolate cache off; the native launcher consumes this marker and
 * restores the qualified cache base for workers. This avoids an IPC-unowned
 * respawn without changing the kernel's cache or resource-lifetime policy. */
export function gatewayCompileCacheEnvironment(packageRoot: string, base: string, env: NodeJS.ProcessEnv = process.env): Record<string,string> {
  const result: Record<string,string> = { NODE_COMPILE_CACHE: gatewayCompileCacheDirectory(packageRoot, base) };
  if (env.NODE_DISABLE_COMPILE_CACHE !== undefined) return result;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot,"package.json"),"utf8"));
    const compatibility = JSON.parse(fs.readFileSync(path.join(packageRoot,"cryoclaw-kernel-compat.json"),"utf8"));
    if (compatibility.version === pkg.version && compatibility.foregroundCompileCache === "workers") {
      result.NODE_DISABLE_COMPILE_CACHE = "1";
      result.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED = "gateway";
    }
  } catch { /* Older or incomplete packages retain the existing launcher policy. */ }
  return result;
}
