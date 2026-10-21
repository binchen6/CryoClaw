# Theme design brief

The Appearance page sends a filled-in template. Map each line literally; blank lines mean "keep the current appearance":

- Theme name: {short memorable name}
- Style direction: {required; the visual character the user described}
- Primary color: {hex value or color name}
- Secondary color: {restrained accent; used sparingly}
- Light/dark preference: {which variant leads; both still ship}
- Corner tendency: {square/small → 0–8, medium → 10–14, large → 16–24}
- Typography preference: {preserve MiSans/Inter defaults unless requested; size/weight}
- Must keep: {hard constraints — fonts, layout, controls that must stay usable}
- Avoid: {things the user explicitly rejected}
- Extra requirements: {anything else to emphasise}
- Preview mode: {light/dark/system the preview starts in}
- Reference images: {0–4 attached images}

Color roles: {one clear accent, restrained secondary accents, coherent paired light/dark palettes, quiet surfaces and readable text}
Controls: {corners, density, shadows and border width, plus registered element adjustments explicitly requested}
Conversation: {user/assistant bubble backgrounds and paired text; spacing and readability}
Composer and icons: {composer/input surfaces, border, icon tint/size/stroke; preserve usable controls}
Compatibility: {preserve unknown/unspecified current settings; no unregistered targets}

Design one coherent working theme. Prioritize readable conversations and clear controls. Provide coordinated palettes.light and palettes.dark; align paletteMode with colors. Check text/background, muted/background, text/surface and bubble-text/bubble pairs against 4.5:1 in both variants. Keep focus, scrolling, click targets and Escape/revert usable. Unspecified typography, layout and component adjustments stay unchanged. Resolve contradictory brief fields by preserving explicitly marked must-keep constraints.

Reference images are mood boards, not layouts. Use them only for palette, light/dark depth and texture. Do not copy their text, logos, brand marks, people or specific layout; do not embed or re-host them; never put image data or links in the theme package. When the brief has no images, rely on the written fields only.

Return exactly a version-1 `cryoclaw-theme` JSON package matching the skill schema. Include the optional top-level `description` (≤120 characters) and use the optional `density` (0.9–1.1), `shadow` (`none`/`soft`/`default`/`strong`) and `borderWidth` (0–2) fields only when the brief points at them; omit them (or use their defaults) to keep the current look. Old packages without these fields stay valid. Preserve existing component adjustments unless the user requests a reset. Check numbers and color formats, then call the preview helper. Explain the visible changes in at most three sentences, and accurately distinguish preview from saved state.

Prefer semantic palette roles (`userBubble`, `assistantBubble`, `userText`, `assistantText`, `composer`, `input`, `icon`, `border`) for changes that should follow every conversation. Use inspected component IDs for local geometry and icon stroke/size changes. Keep unrequested roles inherited, retain clear focus and disabled states, and never hide quota or action controls. A default light appearance uses pure white; do not introduce a beige wash unless requested. Check short messages, long messages, an empty composer and the dark counterpart before reporting success. Keep the package under 64 KiB.

If preview fails, use the bounded recovery procedure in SKILL.md, correct only your temporary package or invocation, and verify another preview before reporting success.
