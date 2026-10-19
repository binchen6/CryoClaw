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

Windows local build: put Git Bash's `bin` directory before WindowsApps in PATH; use a local preload to normalize `process.cwd()` to forward slashes and handle directory junctions. Run `node node_modules/vercel/dist/index.js build --yes`, then `node node_modules/@cloudflare/next-on-pages/bin/index.js --skip-build` to avoid the converter's `spawn npx ENOENT` issue. The local compatibility preload stays untracked.
