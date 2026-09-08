/**
 * virtual-path-reload.ts — R59 刷新兜底判定（纯逻辑，可单测）。
 *
 * Chat UI 用 history.pushState 把地址改写成虚拟路径（/chat、/settings 等，见
 * chat-ui app-settings.ts syncUrlWithTab）。Ctrl+R / 窗口刷新会把虚拟路径当真实
 * 文件请求，主帧 ERR_FILE_NOT_FOUND 后渲染层变空白错误页——会话与在途 run 输出
 * 全部丢失。本模块判定一次主帧加载失败是否属于该形态，并给出回退入口 URL
 * （沿用首载 gatewayUrl/token，附加失败 URL 的 ?session 保会话）。
 */

export const ERR_FILE_NOT_FOUND = -6;

export type VirtualPathRecovery = {
  recover: boolean;
  /** 回退重载目标（含 gatewayUrl/token/session query）；recover=false 时为 null */
  recoveryUrl: string | null;
};

/** 入口 URL 所在目录（含尾斜杠） */
function dirOf(pathname: string): string {
  const idx = pathname.lastIndexOf("/");
  return idx >= 0 ? pathname.slice(0, idx + 1) : "/";
}

export function resolveVirtualPathReload(
  code: number,
  failedUrl: string,
  lastEntryUrl: string | null | undefined,
): VirtualPathRecovery {
  if (code !== ERR_FILE_NOT_FOUND || !lastEntryUrl) {
    return { recover: false, recoveryUrl: null };
  }
  let failed: URL;
  let entry: URL;
  try {
    failed = new URL(failedUrl);
    entry = new URL(lastEntryUrl);
  } catch {
    return { recover: false, recoveryUrl: null };
  }
  // 只处理 chat-ui 目录下的虚拟路径：与入口同目录且不是入口文件本身
  // （入口 index.html 自身失败说明产物缺失，兜底重载只会循环）
  const dir = dirOf(entry.pathname);
  if (!failed.pathname.startsWith(dir) || failed.pathname === entry.pathname) {
    return { recover: false, recoveryUrl: null };
  }
  const session = failed.searchParams.get("session")?.trim();
  if (session) {
    entry.searchParams.set("session", session);
  }
  return { recover: true, recoveryUrl: entry.toString() };
}
