"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const UPSTREAM_SHA256 = "fc6be46f07a79f4fac3ac1ac7baf7701bf18d116b70705b00994eeecc59007c3";
const UPSTREAM_LIFECYCLE = `async function initFeatures(account, cfg, log4) {
  triggerUpdateCheck(log4);
  const existing = getApprovalHandler(account.accountId);
  if (existing) {
    await existing.stop();
    unregisterApprovalHandler(account.accountId);
  }
  const approvalLog = log4.child("approval");
  try {
    const handler = new QQBotApprovalHandler({
      accountId: account.accountId,
      appId: account.appId,
      clientSecret: account.clientSecret,
      cfg,
      log: approvalLog
    });
    registerApprovalHandler(account.accountId, handler);
    await handler.start();
    approvalLog.info("registered");
  } catch (e) {
    approvalLog.debug(\`not available: \${e}\`);
  }
}`;
const MANAGED_LIFECYCLE = UPSTREAM_LIFECYCLE.replace("  triggerUpdateCheck(log4);",
  "  // CryoClaw manages plugin versions; manual bot-version/getUpdateInfo remain available.");

function occurrenceCount(source, block) { return source.split(block).length - 1; }

function assertPackageContract(pkg) {
  if (pkg.name !== "@tencent-connect/openclaw-qqbot" || pkg.version !== "2.0.4" || pkg.main !== "dist/index.cjs") {
    throw new Error("Tencent QQ identity/version/entry contract changed; review the managed startup policy");
  }
}

// Match the complete readable lifecycle body, not a global/minified call pattern.
function adaptQQBotStartupBundle(source, pkg) {
  assertPackageContract(pkg);
  const originalCount = occurrenceCount(source, UPSTREAM_LIFECYCLE);
  const managedCount = occurrenceCount(source, MANAGED_LIFECYCLE);
  if (originalCount + managedCount !== 1) {
    throw new Error("Tencent QQ lifecycle build contract changed; review automatic update checks");
  }
  return managedCount ? source : source.replace(UPSTREAM_LIFECYCLE, MANAGED_LIFECYCLE);
}

function applyManagedQQBotPolicyUnchecked(pluginDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
  assertPackageContract(pkg);
  const bundlePath = path.join(pluginDir, "dist", "index.cjs");
  const original = fs.readFileSync(bundlePath, "utf8");
  const adapted = adaptQQBotStartupBundle(original, pkg);
  // Validate the full upstream artifact on fresh and already-adapted copies.
  // Restoring our one change also rejects unrelated edits to a managed build.
  const restored = original.replace(MANAGED_LIFECYCLE, UPSTREAM_LIFECYCLE);
  if (createHash("sha256").update(restored).digest("hex") !== UPSTREAM_SHA256) {
    throw new Error("Tencent QQ bundle SHA256 build contract changed; review the pinned upstream artifact");
  }
  if (adapted !== original) fs.writeFileSync(bundlePath, adapted, "utf8");
  return { changed: adapted !== original, version: pkg.version, upstreamSha256: UPSTREAM_SHA256 };
}

function applyManagedQQBotPolicy(pluginDir) {
  try { return applyManagedQQBotPolicyUnchecked(pluginDir); }
  catch (error) {
    // Cross-target optional-vendor fallback must never publish an unchecked QQ bundle.
    error.code = "CRYOCLAW_QQBOT_MANAGED_CONTRACT";
    throw error;
  }
}

module.exports = { adaptQQBotStartupBundle, applyManagedQQBotPolicy };
