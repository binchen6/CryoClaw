import fs from "node:fs";
import path from "node:path";
const policy = require("../shared/kernel-runtime-policy.cjs") as { syncNativeKernelVersion: (resources: string) => boolean };

/** An explicit installed policy must never silently fall back to an older Electron Node. */
export function nativeGatewayNode(resources: string, platform = process.platform): string | null {
  const marker = path.join(resources, "runtime", "cryoclaw-runtime.json");
  if (!fs.existsSync(marker)) return null;
  const policy = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (policy.kind !== "node" || policy.gatewayMode !== "loose") throw new Error("Invalid bundled gateway runtime policy");
  const binary = path.join(resources, "runtime", platform === "win32" ? "node.exe" : "node");
  if (!fs.statSync(binary).isFile()) throw new Error("Bundled gateway Node runtime is missing");
  return binary;
}

export function syncNativeKernelVersion(resources: string): boolean {
  return policy.syncNativeKernelVersion(resources);
}
