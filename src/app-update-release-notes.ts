/**
 * app-update-release-notes.ts — 更新弹窗的「新版本说明」获取。
 *
 * 背景：app-updater 的本地兜底 readReleaseNotesForVersion() 读的是**当前安装版**
 * 打包时内置的 release-notes.json，其中不可能包含尚未安装的新版本条目；
 * 因此发现新版本时改从 GitHub Release 正文（发布时按 "## 中文 / ## English"
 * 双段生成）拉取并解析为 {zh, en}。任何失败都静默返回 null，不阻断更新流程。
 */

import * as https from "https";

const GITHUB_RELEASE_API = "https://api.github.com/repos/binchen6/CryoClaw/releases/tags/";
const FETCH_TIMEOUT_MS = 10 * 1000;

export type ReleaseNotes = { zh?: string; en?: string } | null;

/** 按 "## 中文" / "## English" 二级标题切分 release 正文；产出纯文本（去 markdown 弹点）。 */
export function parseReleaseBodyNotes(body: string): ReleaseNotes {
  if (!body) return null;
  const zh = extractSection(body, "中文");
  const en = extractSection(body, "English");
  if (!zh && !en) return null;
  const notes: { zh?: string; en?: string } = {};
  if (zh) notes.zh = zh;
  if (en) notes.en = en;
  return notes;
}

function extractSection(body: string, heading: string): string | undefined {
  const lines = body.split(/\r?\n/);
  let collecting = false;
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,6}\s/.test(line)) {
      if (collecting) break; // 进入下一节（"## English" / 引用块后的其他标题）
      if (line.replace(/^#+\s*/, "").trim() === heading) collecting = true;
      continue;
    }
    if (!collecting) continue;
    if (line.startsWith(">")) continue; // 签名/免责等块引用说明，不进更新弹窗
    const text = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trimEnd();
    out.push(text);
  }
  const joined = out.join("\n").replace(/\n{2,}/g, "\n").trim();
  return joined || undefined;
}

const cache = new Map<string, ReleaseNotes>();

/** 拉取指定版本的 GitHub Release 正文并解析；失败（网络/超时/解析）返回 null，绝不抛出。 */
export function fetchReleaseNotesFromGitHub(version: string): Promise<ReleaseNotes> {
  const hit = cache.get(version);
  if (hit !== undefined) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const req = https.get(
      `${GITHUB_RELEASE_API}v${encodeURIComponent(version)}`,
      { headers: { "User-Agent": "CryoClaw-Updater", Accept: "application/vnd.github+json" }, timeout: FETCH_TIMEOUT_MS },
      (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            let notes: ReleaseNotes = null;
            try {
              notes = parseReleaseBodyNotes(JSON.parse(Buffer.concat(chunks).toString("utf8"))?.body ?? "");
            } catch {
              notes = null;
            }
            cache.set(version, notes);
            resolve(notes);
          });
          res.on("error", () => resolve(null));
        } else {
          res.resume(); // 丢弃响应体，让请求自然结束
          resolve(null);
        }
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}
