import * as fs from "node:fs/promises";

/** Read only the bounded tail; never allocate a buffer the size of an old log. */
export async function readFileTail(file: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 8 * 1024 * 1024) throw new Error("Invalid log budget");
  if (!maxBytes) return Buffer.alloc(0);
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Log is not a regular file");
    const length = Math.min(stat.size, maxBytes), buffer = Buffer.alloc(length), start = stat.size - length;
    let offset = 0;
    while (offset < length) {
      const {bytesRead} = await handle.read(buffer, offset, length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
