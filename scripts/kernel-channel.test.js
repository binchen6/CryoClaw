// kernel-channel.js 单元测试
const test = require("node:test");
const assert = require("node:assert/strict");
const kch = require("./lib/kernel-channel.js");

test("isValidKernelVersion 接受日历版本与 prerelease 后缀", () => {
  assert.ok(kch.isValidKernelVersion("2026.8.2"));
  assert.ok(kch.isValidKernelVersion("2026.7.1-2"));
  assert.ok(kch.isValidKernelVersion("2026.9.1-rc.3"));
});

test("isValidKernelVersion 拒绝非法输入", () => {
  for (const v of ["", "2026.8", "x.y.z", "2026.8.2 ", " 2026.8.2", "2026.8.2;rm", null, 2026, {}, "a".repeat(65)]) {
    assert.ok(!kch.isValidKernelVersion(v), `应拒绝: ${JSON.stringify(v)}`);
  }
});

test("compareKernelVersions 三段数字比较", () => {
  assert.equal(kch.compareKernelVersions("2026.7.1-2", "2026.8.2"), -1);
  assert.equal(kch.compareKernelVersions("2026.8.2", "2026.8.2"), 0);
  assert.equal(kch.compareKernelVersions("2026.9.1", "2026.8.2"), 1);
  assert.equal(kch.compareKernelVersions("2026.8.10", "2026.8.2"), 1); // 数字比较而非字典序
  assert.equal(kch.compareKernelVersions("2027.1.0", "2026.12.9"), 1);
});

test("compareKernelVersions 忽略 prerelease 后缀（同代）", () => {
  assert.equal(kch.compareKernelVersions("2026.7.1-2", "2026.7.1"), 0);
  assert.equal(kch.compareKernelVersions("2026.7.1-rc.1", "2026.7.1-2"), 0);
});

test("compareKernelVersions 非法输入返回 null", () => {
  assert.equal(kch.compareKernelVersions("bad", "2026.8.2"), null);
  assert.equal(kch.compareKernelVersions("2026.8.2", ""), null);
});

test("parseChannelManifest 解析合法清单", () => {
  assert.deepEqual(kch.parseChannelManifest({ stable: "2026.8.2" }), { stable: "2026.8.2" });
  assert.deepEqual(
    kch.parseChannelManifest({ stable: "2026.8.2", minSupported: "2026.7.0" }),
    { stable: "2026.8.2", minSupported: "2026.7.0" }
  );
});

test("parseChannelManifest 拒绝坏清单", () => {
  assert.throws(() => kch.parseChannelManifest(null));
  assert.throws(() => kch.parseChannelManifest({}));
  assert.throws(() => kch.parseChannelManifest({ stable: "latest" }));
  assert.throws(() => kch.parseChannelManifest({ stable: "2026.8.2", minSupported: "x" }));
  assert.throws(() => kch.parseChannelManifest("2026.8.2"));
});
