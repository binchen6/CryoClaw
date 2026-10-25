# Website font subsets

Source files were selected from the user's local font library (`font/README.md`).

- CryoMiSans.woff2: MiSans VF, subset to page and interaction copy; see MiSans-LICENSE.pdf.
- CryoInter.woff2: Inter Variable, Latin/punctuation/arrows subset; see Inter-OFL.txt.
- CryoMono.woff2: JetBrains Mono Variable, Latin/punctuation/arrows subset; see JetBrainsMono-OFL.txt.

These are self-hosted WOFF2 files, not calls to third-party font CDNs. When page copy changes, regenerate the MiSans character subset with `scripts/subset-website-fonts.py`.
