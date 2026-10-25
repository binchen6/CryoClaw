# CryoClaw website

Static product page, published at https://cryoconite.cn/CryoClaw through the blog's Cloudflare Pages project (native Git integration is connected).

- `design-tokens.css` contains a copy of `shared/design-tokens.css` followed by website scale tokens. Keep the desktop colors, typography stacks, radii and motion in sync when refreshing it. The page follows the app's neutral surfaces, CryoBlue accent, MiSans/Inter type and restrained transitions.
- The page tells five linked stories: installation, conversations, connected workflows, extensions and independent dashboards. Claims describe existing capabilities. The marketplace shelf is a labeled capability illustration; dashboard and module-library images are actual Electron screens with demo data.
- `assets/*.webp` are compressed previews from the current Electron capture in `scripts/capture-dashboard-demo.cjs`; examples use labeled demo data. The video is loaded only when requested.
- `assets/cryoclaw-demo.mp4` is the 58-second, 1080p/30 fps feature and live demo. `promo/latest/` is its self-contained HyperFrames source. All UI clips are recordings of the current Electron build using labeled demo data; recording provenance is stored beside each source clip. See `docs/promo.md` and `promo/latest/workflow.md` for the storyboard and export checks.
- `release.json` is a verified release snapshot. Refresh the version, asset size and GitHub SHA-256 digest together when publishing a release. Initial HTML links and checksum must match it. Live release metadata is optional.
- `/api/cryoclaw-release` and `/api/cryoclaw-dl` live in the blog repository. Pinned downloads can use the snapshot without an API request; the streaming endpoint forwards Range and If-Range, limits waits for upstream headers, rejects HTML proxy responses and falls back to the actual official asset.
- The domestic backup link uses the third-party gh-proxy.com service and is labeled as such. Keep the GitHub original and checksum available.
- Self-hosted MiSans, Inter and JetBrains Mono subsets match the app typography. Licenses are in `assets/fonts/`. Regenerate MiSans after copy changes with `scripts/subset-website-fonts.py --font-library <library path>` (requires fonttools and brotli).
- Add `--check` to that command to verify the shipped WOFF2 files cover every Chinese character and punctuation mark used by the page.
- JavaScript progressively enhances screenshot and platform links into separate keyboard tab groups. With JS disabled, every preview and both platform sections stay visible. The pinned download, third-party mirror label and SHA-256 remain in HTML. Live metadata never replaces them with an older or unverified asset.
- Motion uses the desktop duration/easing tokens: short section entrances, outgoing/incoming tab travel and theme cross-fades. Reduced-motion renders content immediately and disables travel.

Verify locally before syncing:

```powershell
node scripts/check-website.cjs --static
node scripts/check-website.cjs
```

The browser check uses Playwright (or `CRYOCLAW_PLAYWRIGHT_PATH` for an existing runtime), starts its own ephemeral local server, checks desktop/mobile themes and keyboard interactions, and writes screenshots and JSON to `.cache/website-20261025/`. It also checks normal-motion entrances, interrupted tab changes, menu exit and anchor focus. The default local run reads `release.json` rather than the live metadata endpoint, and never follows installer links. Coordinate browser runs when another task is using the same browser runtime.

Sync the deployable page (not the promo source frames) from the CryoClaw repository:

```powershell
node scripts/sync-website.cjs C:\Users\binchen\Desktop\code\blog
```

After checking the blog's TypeScript and download regression tests, commit the site and API changes in the blog, then push `main`. Check the Cloudflare native Git deployment; the separate legacy GitHub Actions deploy job needs Cloudflare secrets configured. Verify `/CryoClaw` and `/CryoClaw/`, metadata, `HEAD` and a small byte-range download after deployment.

Build the blog on clean Linux/WSL. The existing Windows Vercel 34.3.1 output can junction distinct API function folders to one directory; a build can report success while every API executes the last handler written. The blog's `scripts/assert-cryoclaw-build.cjs` checks each public API's emitted name and real path. Do not deploy an output tree that fails this check. A clean build can use `git archive HEAD` in an isolated WSL directory; omit local `.env` files and credentials.
