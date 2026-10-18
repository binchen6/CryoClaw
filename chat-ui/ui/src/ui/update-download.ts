type DownloadHost = {
  requestUpdate(): void;
  startUpdateDownload(): Promise<void>;
};

// Hold the guard until the command settles, including the retry's initial check.
const pendingDownloads = new WeakSet<DownloadHost>();

export function isUpdateDownloadPending(host: DownloadHost): boolean {
  return pendingDownloads.has(host);
}

export async function requestUpdateDownload(host: DownloadHost): Promise<void> {
  if (pendingDownloads.has(host)) return;
  pendingDownloads.add(host);
  host.requestUpdate();
  try {
    await host.startUpdateDownload();
  } finally {
    pendingDownloads.delete(host);
    host.requestUpdate();
  }
}
