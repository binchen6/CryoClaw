# CryoClaw website

Static product page, published at https://cryoconite.cn/CryoClaw through the blog's Cloudflare Pages project (native Git integration is connected).

- `design-tokens.css` contains a copy of `shared/design-tokens.css` followed by website scale tokens. Keep the desktop colors, typography stacks, radii and motion in sync when refreshing it.
- `assets/*.webp` are compressed previews from `promo/screens/`; examples use fictional data. The video is loaded only when requested.
- `release.json` is a verified release snapshot. Refresh the version, asset size and GitHub SHA-256 digest together when publishing a release. Initial HTML links and checksum must match it. Live release metadata is optional.
- `/api/cryoclaw-release` and `/api/cryoclaw-dl` live in the blog repository. Pinned downloads can use the snapshot without an API request; the streaming endpoint forwards Range and If-Range, limits waits for upstream headers, rejects HTML proxy responses and falls back to the actual official asset.
- The domestic backup link uses the third-party gh-proxy.com service and is labeled as such. Keep the GitHub original and checksum available.
- Self-hosted MiSans, Inter and JetBrains Mono subsets match the app typography. Licenses are in `assets/fonts/`. Regenerate MiSans after copy changes with `scripts/subset-website-fonts.py --font-library <library path>` (requires fonttools and brotli).

Sync the deployable page (not the promo source frames) from the CryoClaw repository:

```powershell
node scripts/sync-website.cjs C:\Users\binchen\Desktop\code\blog
```

After checking the blog's TypeScript and download regression tests, commit the site and API changes in the blog, then push `main`. Check the Cloudflare native Git deployment; the separate legacy GitHub Actions deploy job needs Cloudflare secrets configured. Verify `/CryoClaw` and `/CryoClaw/`, metadata, `HEAD` and a small byte-range download after deployment.

Build the blog on clean Linux/WSL. The existing Windows Vercel 34.3.1 output can junction distinct API function folders to one directory; a build can report success while every API executes the last handler written. The blog's `scripts/assert-cryoclaw-build.cjs` checks each public API's emitted name and real path. Do not deploy an output tree that fails this check. A clean build can use `git archive HEAD` in an isolated WSL directory; omit local `.env` files and credentials.
