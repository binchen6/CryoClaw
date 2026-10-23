## Fill-in brief from Appearance

Messages sent from Appearance → Let your agent design a theme carry a structured brief. Treat every filled line as a concrete requirement and every blank line as "keep the current appearance":

- Style direction (required) — the visual character the user described.
- Primary / secondary colors — a hex value or a color name; keep secondary accents restrained.
- Light/dark preference — which variant should lead; the package still ships both.
- Corner tendency, typography preference — map to bounded radius / font fields only.
- Must keep, avoid, extra requirements — hard constraints for the design.
- Preview mode — the mode the preview should start in.
- Reference images — 0–4 images may arrive as attachments on the same message.

Reference images are style references only: extract palette, light/dark depth and texture. Never copy their text, logos, brand marks, people or layout, never embed or re-host them, and never put image data in the theme package. With no images, design from the written brief alone.

## Theme package

```json
{"format":"cryoclaw-theme","version":1,"name":"Theme name","description":"One line about the theme's character (≤120 chars)","appearance":{"mode":"system","paletteMode":"light","font":"studio","size":14,"weight":400,"italic":false,"lineHeight":1.55,"radius":12,"density":1,"shadow":"default","borderWidth":1,"colors":{"accent":"#1a6fd0","secondary":"#218363","background":"#ffffff","surface":"#f5f7fa","text":"#333842","muted":"#626b78"},"palettes":{"light":{"accent":"#1a6fd0","secondary":"#218363","background":"#ffffff","surface":"#f5f7fa","text":"#333842","muted":"#626b78"},"dark":{"accent":"#85c2ee","secondary":"#71c6a3","background":"#13161e","surface":"#202735","text":"#e3e8ef","muted":"#a8b2c0"}},"components":{}}}
```

Generate both `palettes.light` and `palettes.dark`. Keep `colors` equal to the palette identified by `paletteMode`. Use `secondary` for restrained accents. A missing counterpart uses the app default, so do not omit it from newly generated themes.

### Optional package fields

`format` stays `cryoclaw-theme` and `version` stays `1`; the following top-level / appearance fields are optional, so old packages remain valid.

- `description` (top level): one line, at most 120 characters. Shown on the theme card after import; keep it factual, no credentials.
- `appearance.density`: spacing multiplier 0.9–1.1. It scales the app's spacer ladder, so use 0.95–0.98 for tighter work surfaces and 1.02–1.05 for airier reading. Omit or use 1 for the current rhythm.
- `appearance.shadow`: `none`, `soft`, `default` or `strong`. Maps the `--shadow-*` ladder; omit or use `default` for the current depth.
- `appearance.borderWidth`: hairline thickness 0–2px. Omit or use 1 for the current hairline; 0 removes visible hairlines, 2 gives bolder card edges.

Use these fields only when the brief points at them, and always keep text/surface contrast at 4.5:1 in both variants.

### Conversation and control roles

Each palette also accepts optional six-digit hex `userBubble`, `assistantBubble`, `userText`, `assistantText`, `composer`, `input`, `icon`, and `border`. These roles apply across conversations without depending on message indices. Omit a role to inherit the app's styling. Pair bubble text with its background and check both variants. Keep the default light background pure white (`#ffffff`) unless the user explicitly requests another color.

Inspection exposes `userBubble`, `assistantBubble`, `composerField`, `messageText`, and `icon` component kinds in addition to existing targets. Use semantic palette roles for all messages; use inspected IDs only for the specific visible element requested. Components additionally accept `gap` and `margin` (0–96px), `strokeWidth` (0–6), `iconSize` (8–96px), and `borderStyle` (`solid`, `dashed`, `none`). Icon controls adjust existing artwork; never embed executable SVG, arbitrary markup, external icon URLs, or invented targets. Preserve focus, click areas, quota visibility and message action readability.

`mode` optionally selects `light`, `dark` or `system`. `font` is `studio` (Inter + MiSans VF and JetBrains Mono) or `system`. Font size 12–22, weight 100–900 including fractions, line height 1.3–2, global corners 0–48. Colors are six-digit hex. Packages must fit in 64 KiB.

`components` contains registered IDs returned by inspection, scoped to the page and settings tab. Each entry supports `x`/`y` (-600–600px), `radius` (0–96px), optional `width` (24–3200px), `height` (20–1600px), `padding` (0–96px), `opacity` (0–1), `borderWidth` (0–12px), integer `zIndex` (0–100), `fontSize` (10–72px), `fontWeight` (100–900), `fontStyle` (`normal`/`italic`), `textAlign` (`left`/`center`/`right`), and `background`/`color`/`borderColor` (six-digit hex). Preserve unspecified properties. Verify the normalized preview response; never invent element IDs or claim unsupported attributes were applied.


## Error recovery

The helper retries one transient local control-service failure, rereading the private port/token configuration each time. Validation errors are not blindly retried. A successful retry includes `recoveryAttempts` in its JSON output.

If a command still fails, diagnose and repair within at most three rounds: verify `ELECTRON_RUN_AS_NODE=1` and the bundled runtime, the temporary theme path, valid JSON/version/64 KiB size, paired colors and actual registered IDs. Re-inspect and re-preview after each correction. Only repair your temporary package or retry the supported helper. Do not inspect/print credentials or tokens, overwrite app/project files, install packages, or restart an active gateway. Preserve the generated package and give the specific failed step plus an actionable next step if recovery is exhausted. Never claim the preview succeeded without a successful helper response.
