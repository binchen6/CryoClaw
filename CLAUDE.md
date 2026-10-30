# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# CryoClaw — Electron Shell for openclaw

## What This Project Is

CryoClaw is a cross-platform desktop app that wraps the [openclaw](https://github.com/openclaw/openclaw) gateway into a standalone installable package. It ships a bundled Node.js 24 runtime and the openclaw npm package, so users need zero dev tooling — just install and run.

**Three-process architecture:**

```
Electron Main Process
  ├── Gateway child process  (bundled Node.js 24.22.1 → physical openclaw tree, default port 18789)
  └── BrowserWindow          (loads Lit Chat UI via file://, connects to gateway via WebSocket)
```

The main process opens the local Lit Chat UI early (via `file://`) while it starts and checks the gateway subprocess. The UI displays connection progress, then connects over WebSocket for chat and HTTP for API calls. A system tray icon keeps the app alive when all windows are closed. OpenClaw 2026.10.9 requires a newer Node patch than Electron embeds: the current product keeps standalone Node and a physical gateway directory. `runtime/cryoclaw-runtime.json` selects this pair; old ASAR helpers are compatibility code, not the current release path. See docs/REVIEW-2026.1023.0.md before changing runtime or patch policy.

## Tech Stack

| Layer | Choice |
|---|---|
| Shell | Electron with Node 24; resolved version is locked in package-lock.json |
| Language | TypeScript → CommonJS in main; Vite ESM in the Chat UI |
| Chat UI | Lit 3 + Vite (file:// loaded SPA) |
| Packager | electron-builder, resolved version locked in package-lock.json |
| Updater | electron-updater (GitHub Releases provider) |
| Targets | macOS DMG + ZIP (arm64/x64), Windows NSIS (x64/arm64) |
| Version scheme | Calendar-based: `YYYY.MMDD.N` (e.g. `2026.904.0`), manually bumped in `package.json` (see docs/releasing.md) |

## Repository Layout

```
cryoclaw/
├── src/                    # Main-process TypeScript modules and regression tests
│   ├── main.ts             # App entry, lifecycle, IPC, Dock toggle, config recovery
│   ├── constants.ts        # Path resolution (dev vs packaged vs ASAR), health check params
│   ├── gateway-process.ts  # Child process state machine + diagnostics
│   ├── gateway-auth.ts     # Auth token read/generate/persist
│   ├── window.ts           # BrowserWindow lifecycle, token injection, retry
│   ├── window-close-policy.ts  # Close behavior: hide vs destroy
│   ├── tray.ts             # System tray icon + i18n context menu
│   ├── preload.ts          # contextBridge IPC whitelist (source of truth for methods/events)
│   ├── provider-config.ts  # Provider presets, verification, config R/W
│   ├── setup-ipc.ts        # Setup validation + config write + CLI install
│   ├── setup-completion.ts # Setup wizard completion detection
│   ├── install-detector.ts # Setup Step 0: installation conflict detection
│   ├── cryoclaw-config.ts   # CryoClaw ownership config (deviceId, setupCompletedAt, migration)
│   ├── settings-ipc.ts     # Thin entry: registers all settings IPC from src/settings/
│   ├── settings/           # Settings IPC modules (verify/channels/weixin/pairing/webbridge/advanced/cli/backup/about)
│   ├── config-backup.ts    # Rolling backups + last-known-good snapshot + restore
│   ├── share-copy.ts       # Remote share copy content (CDN fetch + local fallback)
│   ├── kimi-config.ts      # Kimi robot plugin + Kimi Search configuration
│   ├── kimi-oauth.ts       # Kimi OAuth device code login + token refresh
│   ├── skill-store.ts      # Skill marketplace (clawhub CLI integration)
│   ├── build-config.ts     # Build-time injected config reader (PostHog, registry URL)
│   ├── cli-integration.ts  # CLI wrapper generation, PATH injection (POSIX + Windows)
│   ├── launch-at-login.ts  # macOS/Windows launch at login toggle
│   ├── channel-pairing-store.ts    # Per-channel approved-user sidecar (allowFrom storage)
│   ├── wecom-config.ts     # WeCom (企业微信) plugin config
│   ├── weixin-config.ts    # WeChat (微信) plugin config
│   ├── dingtalk-config.ts  # DingTalk connector plugin config
│   ├── qqbot-config.ts     # QQ Bot plugin config
│   ├── analytics.ts        # Telemetry (PostHog-style, retry + fallback URL)
│   ├── analytics-events.ts # Event classification + property sanitization
│   └── logger.ts           # Dual-write logger (file + console)
├── chat-ui/                # Lit-based Chat UI SPA (file:// loaded)
│   └── ui/                 # Vite project: Lit 3 components, sidebar, settings view, model selector
├── setup/                  # Static setup assets
│   └── webbridge-enable-guide.html  # WebBridge enable guide
├── builtin-skills/         # CryoClaw-owned skills, bundled into app and copied to ~/.openclaw/workspace/skills/ on first launch
│   ├── officecli-docx/     # DOCX read/write skill backed by bundled OfficeCLI binary
│   ├── officecli-pptx/     # PPTX read/write skill backed by bundled OfficeCLI binary
│   └── officecli-xlsx/     # XLSX read/write skill backed by bundled OfficeCLI binary
├── scripts/
│   ├── package-resources.js    # Downloads Node.js 24 + installs openclaw from npm
│   ├── afterPack.js            # electron-builder hook: injects resources post-strip
│   ├── run-mac-builder.js      # macOS build wrapper (sign + notarize)
│   ├── run-with-env.js         # .env loader for child processes
│   ├── merge-release-yml.js    # Merges per-arch latest.yml for auto-updater
│   ├── generate-icons.js       # App icon generator (ice-blue gradient)
│   ├── installer.nsh           # NSIS custom installer script
│   ├── lib/                    # Shared script utilities
│   ├── dist-all-parallel.sh    # Parallel cross-platform build
│   ├── clean.js                # npm run clean: removes build outputs only, never user data
│   └── clean.sh                # Wipes user data (~/.openclaw + macOS app caches) for first-launch testing; asks for confirmation, --yes for non-interactive
├── assets/                 # Icons: .icns, .ico, .png, tray templates
├── docs/                   # Architecture, design guidelines, IPC/gotchas docs (index: docs/README.md)
├── .github/workflows/      # CI: tests.yml (full regression on push/PR)
├── electron-builder.yml    # Build config (DMG + ZIP for mac, NSIS for win)
├── tsconfig.json           # target ES2022, module CommonJS
└── .env                    # Signing keys + build config (gitignored)
```

**Generated at build time (all gitignored):**

```
resources/targets/<platform-arch>/   # Per-target Node.js + gateway deps
  ├── runtime/node[.exe]             # Node.js 24 binary
  ├── gateway/                       # openclaw production node_modules (散文件)
  ├── gateway.asar                   # Gateway ASAR archive (CI 构建产物)
  ├── gateway.asar.unpacked/         # ASAR unpacked files (native modules, extensions)
  └── .node-stamp                    # Incremental build marker
chat-ui/dist/                        # Vite output (Lit Chat UI SPA)
dist/                                # tsc output
out/                                 # electron-builder output (DMG/NSIS)
.cache/node/                         # Downloaded Node.js tarballs
```

## Build Commands

```bash
npm run build                # Vite (chat-ui) + TypeScript → dist/
npm run build:chat           # Build Chat UI only (Lit + Vite)
npm run dev                  # Run in dev mode (electron .) — does NOT rebuild, see gotcha #31
npm run dev:isolated         # Run a second dev instance with its own port + state dir (multi-worktree)
npm run package:resources    # Download Node.js 24 + install openclaw from npm
npm run dist:mac:arm64       # Full pipeline: package → DMG + ZIP (arm64)
npm run dist:mac:x64         # Same for x64
npm run dist:win:x64         # Windows NSIS x64 (via scripts/dist-win.js — runs on macOS and Windows)
npm run dist:win:arm64       # Windows NSIS arm64
npm run dist:all:parallel    # Build all 4 targets in parallel
npm run clean                # Remove all generated build outputs (never touches user data)
```

**Isolated local startup using production config** (skip Setup):

```bash
# First run, or refresh from production config:
rm -f .dev-state/dev.pid .dev-state/cryoclaw.config.json .dev-state/openclaw.json .dev-state/openclaw.json.bak .dev-state/logs/config-health.json
npm run dev:isolated

# Cleanup after the test run:
rm -rf .dev-state && npm run clean && rm -rf chat-ui/dist tsconfig.tsbuildinfo
```

- `dev:isolated` runs with `CRYOCLAW_MULTI_INSTANCE=1`, `OPENCLAW_STATE_DIR=.dev-state`, and a deterministic gateway port in `19000-19999`.
- On a fresh `.dev-state`, it copies `~/.openclaw/cryoclaw.config.json`, `~/.openclaw/openclaw.json`, and credentials, then rewrites `agents.defaults.workspace` to `.dev-state/workspace` so tests do not write into the production workspace.
- Setup is skipped when `.dev-state/cryoclaw.config.json` contains `setupCompletedAt`; use `npm run dev:isolated -- --with-setup` only when testing the Setup Wizard.

**Full build pipeline** (what `dist:mac:arm64` does):

1. `package:resources` — download Node.js 24, `npm install openclaw@<pinned> --production --install-links` plus per-channel plugins, optionally create `gateway.asar` (set `CRYOCLAW_GATEWAY_ASAR=1`)
2. `build:chat` — Vite builds Lit Chat UI into `chat-ui/dist/`
3. `tsc` — compile TypeScript
4. `electron-builder` → `afterPack.js` injects `resources/targets/<target>/` into app bundle → DMG/ZIP/NSIS

### Dev Loop (important)

`npm run dev` only runs `electron .` against whatever is already in `dist/` and `chat-ui/dist/` — it does **not** rebuild. After editing sources, rebuild manually before restarting Electron, or stale bundles will silently swallow your changes:

```bash
npx tsc                 # after editing src/*.ts
npm run build:chat      # after editing chat-ui/ui/** (Lit components)
npm run build           # both at once
```

### Tests

`npm test` runs all four layers with at most two concurrent suites and writes per-layer logs and a JSON summary to `.cache/test-results/`. Chat UI test compilation includes all sources, so it also performs the full type check. Tests are excluded from the production `tsc` build (see `tsconfig.json`; the test compile uses `tsconfig.test.json`). Current verified totals live in docs/OPTIMIZATION-PROGRESS.md and its latest release record; avoid copying historical counts into instructions. Four runners cover the layers below:

| Runner | Script | What it runs |
|---|---|---|
| Vitest | `npm run test:unit:vitest` | Mock-dependent tests listed in `vitest.config.ts` |
| node:test | `npm run test:unit:node` | The remaining `src/*.test.ts`, compiled to `.test-dist/` then run via `node --test` (`scripts/run-node-tests.js`) |
| Chat UI | `npm run test:chat` | chat-ui typecheck + `chat-ui/**/*.test.ts` (`scripts/run-chat-ui-tests.js`) |
| Scripts | `npm run test:scripts` | `scripts/*.test.js` and `scripts/*.test.mjs` via `node --test` |

Run everything with `npm test`, or a single layer (e.g. `npm run test:scripts`).

There is no linter configured; `tsc --noEmit` is the de facto type check.


## Release Routine (per stage)

Open-sourced at `binchen6/CryoClaw` (AGPL-3.0-only); push is allowed (`origin` = GitHub, no pre-push hook).

1. Bump `package.json` version (calendar `YYYY.MMDD.N`) + add a top entry to `release-notes.json` (zh + en).
2. `npm run dist:win` → `out/win32-x64/CryoClaw-Setup-<v>-x64.exe`.
3. Silent install E2E: `node scripts/silent-install.js out/win32-x64/CryoClaw-Setup-<v>-x64.exe <v>` (never pass /S directly from Git Bash — MSYS path rewriting swallows it and the wizard pops up, gotcha #91)
   (must run outside the IDE sandbox — sandbox denies it), confirm
   `%LOCALAPPDATA%\Programs\CryoClaw\CryoClaw.exe` timestamp updated.
4. Launch the app, verify gateway `GET http://127.0.0.1:18789/` returns 200.
5. Run the single UI release gate: `node scripts/release-ui-smoke.js --exe <installed-CryoClaw.exe>`. It shares one app launch, deduplicates the scene matrix and batches scans with critical interaction assertions. Use `--full` for shell/theme rewrites; legacy scripts are for targeted diagnosis. See docs/releasing.md.
6. `git push origin main`; `gh release create v<version>` with the installer attached;
   sync README / docs/OPTIMIZATION-PROGRESS.md (baseline counts, R-stage record).

CI: `.github/workflows/tests.yml` runs the full regression on every push/PR
(chat-ui/ui is an independent npm tree — install it before `test:chat`).


## Key Design Decisions

> Detailed per-module design documentation: [docs/architecture.md](docs/architecture.md)
> Full IPC API reference: [docs/ipc-api.md](docs/ipc-api.md)

**Core subsystems at a glance:**

- **Gateway process** — State machine (`stopped→starting→running→stopping`) with generation tracking to prevent stale exit events. 3 retries on startup, 90s health check timeout, auto-restart on config change.
- **Token injection** — Auth token passed to gateway via env var, injected into BrowserWindow via a `?token=` query param.
- **Provider config** — Unified module shared by Setup + Settings. All Moonshot sub-platforms (moonshot-cn/ai/kimi-code) write `apiKey`+`baseUrl`+`api`+`models` to `models.providers`.
- **Kimi OAuth** — Device code flow via `auth.kimi.com`, 60s refresh interval, 300s refresh threshold.
- **Setup wizard** — Step 0 (conflict detection) → Step 1 (welcome) → Step 2 (provider) → Step 3 (done + CLI + login toggle).
- **Settings** — 13 tabs: Channels(Feishu/WeCom/DingTalk/QQBot/WeChat/Pairing), Provider(+usage), Search, Memory, Voice, Session usage, MCP&Hooks, Appearance, Advanced, Approvals, Backup, Info, About. (Plugin management is the top-level "extensions" view, not a settings tab.)
- **Multi-channel integration** — Feishu / WeCom / DingTalk / QQ Bot / WeChat share a common plugin-enable + channel-config schema. New installs default `dmPolicy: "open"` (with `allowFrom: ["*"]`). Users can opt into `dmPolicy: "pairing"` per channel; approved-user list is maintained via an allowFrom sidecar (no background polling).
- **Skill store** — clawhub CLI integration, skills at `~/.openclaw/workspace/skills/`, registry config in `~/.openclaw/skill-store.json`.
- **Config backup** — Rolling 10 backups + last-known-good snapshot + factory reset.
- **Multi-model management** — IPC handlers for listing, deleting, setting default, and aliasing models across providers.
- **Gateway packaging** — Current releases keep standalone Node 24.22.1 and a physical gateway directory. `cryoclaw.gatewayRuntime=node` overrides stale ASAR flags; native addons target that Node ABI. Product patches are separated from legacy ASAR adapters, and whole-directory updates use complete-backup markers and crash recovery before startup. The old ASAR branch remains for explicit compatibility work; do not re-enable its identity/junction exceptions in the current physical tree. Official channel/provider packages are vendored into `dist/extensions/` because they are no longer included in the core npm tarball.
- **Preload security** — Explicit methods and event listeners via `contextBridge` (sandbox mode); `src/preload.ts` is the authoritative whitelist.

## Runtime Paths (on user's machine)

```
~/.openclaw/
  ├── openclaw.json                    # User config (provider, model, auth token, channels)
  ├── cryoclaw.config.json              # CryoClaw ownership marker (deviceId, setupCompletedAt)
  ├── openclaw.last-known-good.json    # Last successful gateway startup config snapshot
  ├── .device-id                       # Analytics device ID (UUID)
  ├── logs/
  │   ├── app.log                      # Application log (5MB truncate)
  │   └── gateway.log                  # Gateway child process diagnostic log
  ├── config-backups/                  # Rolling config backups (max 10)
  │   └── openclaw-YYYYMMDD-HHmmss.json
  ├── credentials/
  │   └── kimi-search-api-key          # Kimi Search dedicated API key (sidecar file)
  ├── workspace/
  │   └── skills/                      # Installed skills (via clawhub)
  ├── skill-store.json                 # Skill store registry config (standalone)
  └── bin/
      ├── openclaw                     # CLI wrapper script (POSIX) or .cmd (Windows)
      └── clawhub                      # clawhub CLI wrapper
```

## Design Rules

For comprehensive design guidelines, please refer to:

- [Design Guidelines (English)](docs/design-guidelines-en.md)
- [Design Guidelines (Chinese)](docs/design-guidelines-zh.md)

1. **Theme is neutral gray + a single steady blue accent, via design tokens.** Per the 2026.9 R2b design spec, the accent is CryoBlue, a calm work-oriented blue-cyan blend (`--brand-500: #2a89dd`, light-theme primary `--brand-600: #1a6fd0`, secondary cyan `--accent-2`) from `shared/design-tokens.css`, and the light theme is the first-class theme. Always style via design tokens and the surviving `cc-*` primitives (cc-dialog/cc-tag/cc-alert in `chat-ui/ui/src/styles/primitives.css`) — never hardcode hex. See docs/design-guidelines-zh.md for the full spec and docs/archive/ui-rewrite-2026.9-contract.md for the 2026.9 rewrite contract. Semantic status colors (error red, warning amber) are separate from the accent. (The old indigo `#6366f1`, ice-blue `#0EA5E9` and "signature red `#c0392b`" rules are retired.)

2. **No `text-transform: uppercase` on labels.** Labels should display as written — respect the original casing of brand names (Chrome, iMessage) and CJK text.

3. **Use iOS-style Switch for boolean settings**, not radio buttons or checkboxes. Follow the Apple-like toggle pattern (`toggle-switch`): label on the left, switch on the right.

4. **Default action buttons align right.** In settings pages, action rows should right-align buttons by default (`.btn-row { justify-content: flex-end; }`) for a consistent visual rhythm. Only deviate when an inline/list context explicitly requires local actions.

5. **Motion follows "one continuous take" (一镜到底): elements never pop in or vanish — they travel.** Enter from somewhere (fade + short translate from the edge the element is anchored to), exit the way it came (delayed DOM removal with an exit animation, e.g. toast's leaving state), state swaps cross-fade rather than hard-cut (tool status pop). Everything through the motion tokens (`--ease-standard` for panels/entrances, `--ease-spring` for scale entrances, `--duration-fast/normal` ladder); reduced-motion collapses to instant in `base.css`, and new press/translate feedback must be explicitly registered there.

   **Overlays return where they came from.** Any overlay (popover, menu, floating panel) must close by re-triggering the control that opened it, enter and exit along the same anchored edge, and pick its own side/position adaptively inside the viewport — never covering its trigger or the adjacent primary action. Native `popover="auto"` overlays bind their trigger with the declarative `popovertarget` invoker instead of a manual click toggle, because pointerdown light-dismiss plus a click handler is exactly what makes them impossible to close. Positioning goes through `chat-ui/ui/src/ui/utils/popover-placement.ts`. Full rule and acceptance checklist: `docs/design-guidelines-zh.md` § 浮层返回准则（2026.10.30）.

## Writing Style (changelog, comments, docs)

Release notes, code comments, commit messages, and docs are read by busy people. Write like a good editor:

1. **Glanceable first.** Lead with the outcome; one line says what changed and why it matters. Details and ticket-style archaeology go below the fold.
2. **Concise and precise.** Short sentences, concrete nouns, no filler ("在…方面进行了优化" is banned). One fact per clause; numbers over adjectives.
3. **Seasoned, lightly playful.** Competent and calm like a senior engineer's handover note; a dry one-liner is welcome ("删掉幽灵 toast——它从未被任何人调用，也没有人想念它"), but never at the expense of clarity, never cutesy emoji walls, never jokes in error messages or destructive-action warnings.
4. **Same voice in zh and en.** Release notes ship bilingual (`release-notes.json`): translate meaning, not words; keep humor untranslated rather than forced.
5. **Comments explain constraints, not mechanics.** Say why a value is pinned or what breaks if removed — not what the next line does. Changelog entries name the user-visible effect first, then the root cause in one clause.

## Common Gotchas

See [docs/gotchas.md](docs/gotchas.md) for verified packaging, signing, configuration and UI constraints. Its numbered entries are the source of truth.

When you encounter a non-trivial problem and find a working solution, add it to `docs/gotchas.md` so future developers don't repeat the same investigation.
