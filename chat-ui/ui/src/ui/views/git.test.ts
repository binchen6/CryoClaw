import test from "node:test";
import assert from "node:assert/strict";
import { renderGitPanel, type GitPanelProps } from "./git.ts";

function clickHandlers(value: unknown, out: Array<(event: Event) => void> = []) {
  if (Array.isArray(value)) { for (const item of value) clickHandlers(item, out); }
  else if (value && typeof value === "object" && "strings" in value && "values" in value) {
    const template = value as { strings: string[]; values: unknown[] };
    template.values.forEach((item, index) => {
      if (typeof item === "function" && /@click\s*=\s*$/.test(template.strings[index])) out.push(item as (event: Event) => void);
      else clickHandlers(item, out);
    });
  }
  return out;
}

test("rename row and unstage-all include both index paths without duplicates", () => {
  const calls: string[][] = [];
  const noop = () => {};
  const props = {
    connected: true, gitAvailable: true, repoState: "ok", repoOptions: [], repoPath: "/repo", busyPaths: new Set(), commitMessage: "",
    status: { branch: { head: "main", oid: "abc", upstream: null, ahead: 0, behind: 0 }, entries: [
      { kind: "renamed", path: "new.txt", origPath: "old.txt", index: "R", worktree: "." },
      { kind: "tracked", path: "old.txt", index: "A", worktree: "." },
    ] },
    onUnstage: (paths: string[]) => calls.push(paths), onSelectFile: noop, onStage: noop,
    onToggleBranchPanel: noop, onRefresh: noop, onPush: noop, onPull: noop,
    onCommit: noop, onCommitMessageChange: noop,
  } as unknown as GitPanelProps;
  for (const click of clickHandlers(renderGitPanel(props))) click({ stopPropagation: noop } as unknown as Event);
  assert.deepEqual(calls, [["new.txt", "old.txt"], ["new.txt", "old.txt"], ["old.txt"]]);
});

test("unstaging a copy keeps the source file's independently staged edits", () => {
  const calls: string[][] = [];
  const noop = () => {};
  const props = { connected: true, gitAvailable: true, repoState: "ok", repoOptions: [], repoPath: "/repo", busyPaths: new Set(), commitMessage: "",
    status: { branch: { head: "main" }, entries: [
      { kind: "renamed", path: "copy.txt", origPath: "source.txt", index: "C", worktree: "." },
      { kind: "tracked", path: "source.txt", index: "M", worktree: "." },
    ] }, onUnstage: (paths: string[]) => calls.push(paths), onSelectFile: noop, onStage: noop,
    onToggleBranchPanel: noop, onRefresh: noop, onPush: noop, onPull: noop, onCommit: noop, onCommitMessageChange: noop,
  } as unknown as GitPanelProps;
  for (const click of clickHandlers(renderGitPanel(props))) click({ stopPropagation: noop } as unknown as Event);
  assert.deepEqual(calls, [["copy.txt", "source.txt"], ["copy.txt"], ["source.txt"]]);
});
