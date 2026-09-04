// kernel-channel.js — 内核稳定版策展渠道（纯逻辑，node:test 可测）
//
// 背景：openclaw 官方 npm dist-tag latest 会指向尚未完成发行证据链的版本
// （如 2026.9.1，GitHub release 自述 ClawHub publish 未验证、部分测试豁免未跑），
// 直接拿 latest 当"可更新目标"会诱导用户装上非稳定内核。
// 改为 CryoClaw 策展：kernel-update.mjs 拉取本仓库的 kernel-channel.json
// （远程失败时回退构建期注入的内置兜底版本），只把策展 stable 当更新目标。
//
// 本模块只做纯逻辑：版本比较与清单解析，IO 由调用方注入。

// openclaw 日历版本号：N.N.N 后接可选 -<prerelease>（2026.7.1-2 / 2026.7.1-rc.3）
const KERNEL_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function isValidKernelVersion(v) {
  return typeof v === "string" && v.length > 0 && v.length <= 64 && KERNEL_VERSION_RE.test(v);
}

// 日历版本比较：只比 N.N.N 三个数字段（prerelease 后缀不参与——
// 2026.7.1 与 2026.7.1-2 视为同代，后缀是构建序号而非新旧依据）。
// 返回 -1 / 0 / 1；任一侧非法返回 null（调用方保守处理）。
function compareKernelVersions(a, b) {
  if (!isValidKernelVersion(a) || !isValidKernelVersion(b)) return null;
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// 解析策展清单：{ stable: "2026.8.2", minSupported?: "2026.7.0" }
// 缺 stable 或格式非法 → throw（调用方换下一个来源）。
function parseChannelManifest(data) {
  if (!data || typeof data !== "object") throw new Error("策展清单不是 JSON 对象");
  if (!isValidKernelVersion(data.stable)) {
    throw new Error(`策展清单 stable 字段非法: ${JSON.stringify(data.stable)}`);
  }
  const out = { stable: data.stable };
  if (data.minSupported !== undefined) {
    if (!isValidKernelVersion(data.minSupported)) {
      throw new Error(`策展清单 minSupported 字段非法: ${JSON.stringify(data.minSupported)}`);
    }
    out.minSupported = data.minSupported;
  }
  return out;
}

module.exports = { KERNEL_VERSION_RE, isValidKernelVersion, compareKernelVersions, parseChannelManifest };
