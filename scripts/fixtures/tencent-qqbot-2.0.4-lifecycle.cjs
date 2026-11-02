// Exact unmodified function blocks from @tencent-connect/openclaw-qqbot 2.0.4 dist/index.cjs.
async function initFeatures(account, cfg, log4) {
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
    approvalLog.debug(`not available: ${e}`);
  }
}

async function getUpdateInfo(log4) {
  try {
    const tags = await fetchDistTags(log4);
    return buildUpdateInfo(tags);
  } catch (err) {
    log4?.debug(`[update-checker] check failed: ${err.message}`);
    return { current: CURRENT_VERSION, latest: null, stable: null, alpha: null, hasUpdate: false, checkedAt: Date.now(), error: err.message };
  }
}

function botVersion(_account) {
  return {
    name: "bot-version",
    description: "\u67E5\u770B\u63D2\u4EF6\u7248\u672C\u53F7",
    usage: [
      "/bot-version",
      "",
      "\u67E5\u770B\u5F53\u524D QQBot \u63D2\u4EF6\u7248\u672C\u548C OpenClaw \u6846\u67B6\u7248\u672C\u3002",
      "\u540C\u65F6\u68C0\u67E5\u662F\u5426\u6709\u65B0\u7248\u672C\u53EF\u7528\u3002"
    ].join("\n"),
    handler: async () => {
      const frameworkVersion = getOpenClawVersion();
      const lines = [
        `\u{1F99E}\u6846\u67B6\u7248\u672C\uFF1A${frameworkVersion}`,
        `\u{1F916}QQBot \u63D2\u4EF6\u7248\u672C\uFF1Av${PLUGIN_VERSION2}`
      ];
      const info = await getUpdateInfo();
      if (info.checkedAt === 0) {
        lines.push("\u23F3 \u7248\u672C\u68C0\u67E5\u4E2D...");
      } else if (info.error) {
        lines.push("\u26A0\uFE0F \u7248\u672C\u68C0\u67E5\u5931\u8D25");
      } else if (info.hasUpdate && info.latest) {
        lines.push(`\u{1F195}\u6700\u65B0\u53EF\u7528\u7248\u672C\uFF1Av${info.latest}\uFF0C\u70B9\u51FB <qqbot-cmd-input text="/bot-upgrade" show="/bot-upgrade"/> \u67E5\u770B\u5347\u7EA7\u6307\u5F15`);
      }
      lines.push(`\u{1F31F}\u5B98\u65B9 GitHub \u4ED3\u5E93\uFF1A[\u70B9\u51FB\u524D\u5F80](${GITHUB_URL})`);
      return lines.join("\n");
    }
  };
}
