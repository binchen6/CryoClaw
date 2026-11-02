# QQ Bot 2.0.4 migration and QR setup

The user requested the Tencent QQ Bot upgrade, refreshed channel settings, new capabilities and QR setup while the 2026.1101.0 release was in progress. The current package was stopped; regenerate it after these changes.

## Architecture and contracts

Use `@tencent-connect/openclaw-qqbot@2.0.4`, plugin ID `openclaw-qqbot`, channel key `qqbot`. Preserve `channels.qqbot` and migrate old plugin entry/allow/install references before gateway validation. Package the Tencent plugin and its dependencies in the physical gateway, removing the legacy vendored plugin from final payload and applying the same selection in kernel updates.

QR runs in the main process through the plugin's official `@tencent-connect/qqbot-connector@1.2.0` callback API, with console QR output disabled. Credentials remain in the main process. Generate the QR image locally from the Tencent connect URL; no remote QR-image service. Each attempt belongs to its requesting WebContents and a random attempt ID, has cancellation and an overall deadline, and is discarded when its owner closes. Success reads the latest config, merges all returned accounts, persists once and requests one managed gateway restart. Preserve existing policy/other accounts; new QR accounts allow only the scanning user when an OpenID is supplied. Use documentation-only bot upgrades for the managed bundled runtime.

Trusted IPC:

- `settings:qqbot-login-start`, preload `settingsQqbotLoginStart()` → `{success:true,data:{attemptId:string,status:"waiting",qrDataUrl:string,message:string}}` or `{success:false,message:string}`.
- `settings:qqbot-login-wait`, preload `settingsQqbotLoginWait({attemptId})` → `{success:true,data:{attemptId,status:"waiting"|"connected"|"expired"|"error"|"canceled",qrDataUrl?:string,message:string,accounts?:Array<{accountId:string,appId:string,name?:string}>}}`. Never return AppSecret/OpenID.
- `settings:qqbot-login-cancel`, preload `settingsQqbotLoginCancel({attemptId})` → `{success:boolean}`. Reject another window's attempt.

UI starts only on an explicit click, polls with one in-flight request, refreshes QR images if the connector emits a replacement, and cancels on manual mode, account change, leaving settings, retry or disposal. A generation guard rejects every late response. Connected state reloads real configuration. QR setup cannot be fully authenticated without a person scanning with phone QQ; verify protocol/failure/cancel and persistence using an injectable official connector boundary, and verify a real pre-scan QR without claiming account binding.

## Settings scope

Provide QR and manual credential modes, account selection and existing-account summaries. Keep channel enable separate from a selected account's enable. Expose supported Markdown, private-chat streaming, default group @ requirement, direct media URL upload, DM/group policy and allowlists. WebSocket remains the default; advanced Webhook mode requires an explicit callback path and explanation. Preserve unrepresented advanced fields. Show clear limits that speech/image understanding depends on model configuration. Provide status/error/retry feedback and bilingual copy using the existing settings primitives.

Shared UI helpers: `QQBOT_PLUGIN_ID="openclaw-qqbot"`, channel key constant `QQBOT_CHANNEL_ID="qqbot"`; `extractQqbotView(config, accountId="default")` and `applyQqbotSave(draft, params)` own account-scoped fields and legacy ID replacement. The main-process migration must match this ID policy.

## Verification

- Red→green migration tests: enabled/disabled/allowlisted legacy configs, multiple accounts, unknown keys retained and no credential leakage.
- Red→green QR tests: refresh, success-once persistence, synchronous callbacks, cancellation, owner destruction, stale callbacks, failure/expiry and bounded startup.
- UI tests: generation/cancel, secret preservation, account scope, new settings and save/reload.
- Load the real official plugin with the pinned gateway; do not infer compatibility from TypeScript or a manifest alone.
- Repeat full tests, build, isolated QQ UI, real pre-scan QR, final packaging/install, installed browser/UI/message, asset/update and publish gates.
