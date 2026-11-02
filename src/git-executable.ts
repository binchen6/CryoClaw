import * as fs from "fs";
import * as path from "path";

let executable: string | undefined;

// Resolve PATH once without the child cwd search performed by Windows/libuv.
export function resolveGitExecutable(): string {
  if (executable) return executable;
  for (const entry of (process.env.PATH || process.env.Path || "").split(path.delimiter)) {
    const dir = entry.replace(/^"|"$/g, "");
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, process.platform === "win32" ? "git.exe" : "git");
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      executable = fs.realpathSync(candidate);
      return executable;
    } catch { /* continue through explicit PATH entries */ }
  }
  throw Object.assign(new Error("Git executable not found in PATH"), { code: "ENOENT" });
}
