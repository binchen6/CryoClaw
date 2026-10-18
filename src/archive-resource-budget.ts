// Keep in sync with the native archive extractor; exports obey the same import limits.
// Streaming readers use 64 KiB chunks. These bounds permit large databases while
// staying below classic ZIP's 4 GiB offsets and 65535-entry limit (including metadata).
export const MAX_ARCHIVE_ENTRY_BYTES = 1024 * 1024 * 1024;
export const MAX_ARCHIVE_TOTAL_BYTES = 3 * 1024 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 50_000;
export const MAX_ARCHIVE_DIRECTORY_BYTES = 32 * 1024 * 1024;

export function validateArchiveDirectory(count: number, bytes: number): void {
  if (count > MAX_ARCHIVE_ENTRIES || bytes > MAX_ARCHIVE_DIRECTORY_BYTES) {
    throw new Error("ZIP directory exceeds resource limits (50000 entries, 32 MiB metadata)");
  }
}

export class ArchiveResourceBudget {
  private count = 0;
  private total = 0;
  add(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ARCHIVE_ENTRY_BYTES
      || this.count + 1 > MAX_ARCHIVE_ENTRIES || this.total + bytes > MAX_ARCHIVE_TOTAL_BYTES) {
      throw new Error("ZIP exceeds resource limits (1 GiB per entry, 3 GiB total, 50000 entries)");
    }
    this.count++;
    this.total += bytes;
  }
}
