// archive-backend 单元测试：sidecar 探测/禁用开关/DOS 时间换算。
// sidecar 二进制缺失或显式禁用时的行为 = 纯 JS 现状（由 openclaw-state-archive
// 的契约测试与双 backend 测试共同覆盖）。
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import {
  dateToDosDateTime,
  probeArchiveTool,
  resetArchiveToolProbeForTests,
  resolveArchiveToolCandidates,
} from "./archive-backend.ts";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

test("CRYOCLAW_ARCHIVE_TOOL=off 显式禁用 sidecar（负缓存命中，不探测文件系统）", async () => {
  process.env.CRYOCLAW_ARCHIVE_TOOL = "off";
  process.env.CRYOCLAW_ARCHIVE_TOOL_BIN = path.join("nonexistent", "cryoclaw-archive");
  resetArchiveToolProbeForTests();
  assert.equal(await probeArchiveTool(), null);
  // 缓存生效：第二次不再探测
  assert.equal(await probeArchiveTool(), null);
  restoreEnv();
  resetArchiveToolProbeForTests();
});

test("未构建产物且无 env 覆盖时探测为 null", async () => {
  delete process.env.CRYOCLAW_ARCHIVE_TOOL_BIN;
  resetArchiveToolProbeForTests();
  const handle = await probeArchiveTool();
  // dev 仓库若已 cargo build --release 则可能探测成功——两种结果都合法，
  // 但候选路径必须包含 dev 本地产物与 resources 注入路径
  const candidates = resolveArchiveToolCandidates();
  assert.ok(candidates.some((p) => p.includes(path.join("native", "cryoclaw-archive", "target", "release"))));
  if (!handle) {
    // 无产物时负缓存
    assert.equal(await probeArchiveTool(), null);
  }
  resetArchiveToolProbeForTests();
});

test("CRYOCLAW_ARCHIVE_TOOL_BIN 覆盖优先生效（指向不存在的文件则落后续候选）", async () => {
  process.env.CRYOCLAW_ARCHIVE_TOOL_BIN = path.join("definitely", "missing", "cryoclaw-archive");
  resetArchiveToolProbeForTests();
  const candidates = resolveArchiveToolCandidates();
  assert.equal(candidates[0], path.resolve(process.env.CRYOCLAW_ARCHIVE_TOOL_BIN));
  restoreEnv();
  resetArchiveToolProbeForTests();
});

test("dateToDosDateTime 与 fflate DOS 编码公式一致", () => {
  // 1980-01-01 00:00:00 本地 → dosDate=0x21, dosTime=0（归档 marker 的固定值）
  const marker = dateToDosDateTime(new Date(1980, 0, 1, 0, 0, 0));
  assert.equal(marker.dosDate, 0x21);
  assert.equal(marker.dosTime, 0);

  // 2026-10-08 15:30:44 → 秒取半（44>>1=22）
  const sample = dateToDosDateTime(new Date(2026, 9, 8, 15, 30, 44));
  const year = ((sample.dosDate >> 9) & 0x7f) + 1980;
  const month = ((sample.dosDate >> 5) & 0x0f) - 1;
  const day = sample.dosDate & 0x1f;
  const hour = (sample.dosTime >> 11) & 0x1f;
  const minute = (sample.dosTime >> 5) & 0x3f;
  const second = (sample.dosTime & 0x1f) * 2;
  assert.deepEqual([year, month, day, hour, minute, second], [2026, 9, 8, 15, 30, 44]);
});
