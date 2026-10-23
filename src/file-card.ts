import * as fs from "node:fs/promises";
import * as path from "node:path";

export function assertLocalFilePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 32768 ||
    value.includes("\0") || !path.isAbsolute(value) || /^[/\\]{2}/.test(value) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new Error("A local absolute file path is required");
}

export async function readFileCardInfo(value: unknown) {
  assertLocalFilePath(value);
  try {
    const real = await fs.realpath(value);assertLocalFilePath(real);
    const stat = await fs.stat(real);
    if (!stat.isFile()) return {exists:false,reason:"not-file" as const};
    return {exists:true,size:stat.size,mtimeMs:stat.mtimeMs};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {exists:false,reason:"missing" as const};
    throw error;
  }
}

export async function resolveLocalRegularFile(value:unknown):Promise<string>{
  assertLocalFilePath(value);const real=await fs.realpath(value);assertLocalFilePath(real);
  if(!(await fs.stat(real)).isFile())throw new Error("File is unavailable");return real;
}
