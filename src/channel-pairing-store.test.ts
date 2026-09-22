import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyRemoveAllowFromEntries,
  readChannelAllowFromStoreEntries,
  removeChannelAllowFromStoreEntries,
  writeChannelAllowFromStoreEntries,
} from "./channel-pairing-store";

function createCredentialsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cryoclaw-pairing-store-"));
}

test("readChannelAllowFromStoreEntries 应读取 default 账号作用域的 allowFrom 文件", () => {
  const credentialsDir = createCredentialsDir();
  fs.writeFileSync(
    path.join(credentialsDir, "wecom-default-allowFrom.json"),
    JSON.stringify({ version: 1, allowFrom: ["XuMingYuan"] }, null, 2),
    "utf-8",
  );

  assert.deepEqual(readChannelAllowFromStoreEntries(credentialsDir, "wecom"), ["XuMingYuan"]);
});

test("readChannelAllowFromStoreEntries 应合并 legacy 与 default allowFrom 文件并去重", () => {
  const credentialsDir = createCredentialsDir();
  fs.writeFileSync(
    path.join(credentialsDir, "wecom-allowFrom.json"),
    JSON.stringify({ version: 1, allowFrom: ["legacy-user", "shared-user"] }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(credentialsDir, "wecom-default-allowFrom.json"),
    JSON.stringify({ version: 1, allowFrom: ["shared-user", "default-user"] }, null, 2),
    "utf-8",
  );

  assert.deepEqual(
    [...readChannelAllowFromStoreEntries(credentialsDir, "wecom")].sort(),
    ["default-user", "legacy-user", "shared-user"],
  );
});

test("writeChannelAllowFromStoreEntries 应优先写回 default 账号作用域文件", () => {
  const credentialsDir = createCredentialsDir();

  writeChannelAllowFromStoreEntries(credentialsDir, "wecom", ["XuMingYuan"]);

  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(credentialsDir, "wecom-default-allowFrom.json"), "utf-8")),
    {
      channel: "wecom",
      allowFrom: ["XuMingYuan"],
    },
  );
});

test("writeChannelAllowFromStoreEntries 原子写：落盘内容完整且无 .tmp 残留", () => {
  const credentialsDir = createCredentialsDir();

  writeChannelAllowFromStoreEntries(credentialsDir, "wecom", ["user-a", "user-b"]);

  const filePath = path.join(credentialsDir, "wecom-default-allowFrom.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf-8")), {
    channel: "wecom",
    allowFrom: ["user-a", "user-b"],
  });
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
});

test("applyRemoveAllowFromEntries 应删除指定条目并保持其余顺序", () => {
  assert.deepEqual(
    applyRemoveAllowFromEntries(["a", "b", "c"], ["b"]),
    ["a", "c"],
  );
  assert.deepEqual(
    applyRemoveAllowFromEntries(["a", "b", "c"], ["a", "c", "missing"]),
    ["b"],
  );
  // 空 removeIds / 全空白 removeIds：原样规整返回
  assert.deepEqual(applyRemoveAllowFromEntries(["a", "b"], []), ["a", "b"]);
  assert.deepEqual(applyRemoveAllowFromEntries(["a", "b"], ["  "]), ["a", "b"]);
});

test("removeChannelAllowFromStoreEntries 应写前重读磁盘：并发批准的条目不丢", () => {
  const credentialsDir = createCredentialsDir();
  writeChannelAllowFromStoreEntries(credentialsDir, "wecom", ["keep-a", "remove-me"]);

  // 模拟 gateway `openclaw pairing approve` 在 remove 之前并发写入新批准用户。
  // remove 流程必须在写前重读磁盘，否则基于旧快照覆盖会把该条目静默抹掉。
  writeChannelAllowFromStoreEntries(credentialsDir, "wecom", ["keep-a", "remove-me", "late-approved"]);

  removeChannelAllowFromStoreEntries(credentialsDir, "wecom", ["remove-me"]);

  assert.deepEqual(
    readChannelAllowFromStoreEntries(credentialsDir, "wecom"),
    ["keep-a", "late-approved"],
  );
});

test("removeChannelAllowFromStoreEntries 删空后应删除 store 文件（含 legacy 重复状态）", () => {
  const credentialsDir = createCredentialsDir();
  writeChannelAllowFromStoreEntries(credentialsDir, "wecom", ["only-one"]);
  fs.writeFileSync(
    path.join(credentialsDir, "wecom-allowFrom.json"),
    JSON.stringify({ version: 1, allowFrom: ["legacy-dup"] }, null, 2),
    "utf-8",
  );

  removeChannelAllowFromStoreEntries(credentialsDir, "wecom", ["only-one", "legacy-dup"]);

  assert.deepEqual(readChannelAllowFromStoreEntries(credentialsDir, "wecom"), []);
  assert.equal(fs.existsSync(path.join(credentialsDir, "wecom-default-allowFrom.json")), false);
  assert.equal(fs.existsSync(path.join(credentialsDir, "wecom-allowFrom.json")), false);
});
