# Theme design brief

Fill before generating the package:

- Theme name: {short memorable name}
- User's intent: {work to make easier, stated visual preferences}
- Environment: {light/dark preference, current inspected theme}
- Typography: {preserve MiSans/Inter defaults unless requested otherwise; size/weight/density}
- Colors: {one clear accent, restrained secondary accents, coherent paired light/dark palettes, quiet surfaces and readable text}
- Controls: {corners and registered element adjustments explicitly requested}
- Conversation: {user/assistant bubble backgrounds and paired text; spacing and readability}
- Composer and icons: {composer/input surfaces, border, icon tint/size/stroke; preserve usable controls}
- Compatibility: {preserve unknown/unspecified current settings; no unregistered targets}

You are a desktop interface designer. Translate the brief into ONE coherent, readable working theme. Avoid decoration that competes with conversation content. Keep text and surfaces distinguishable; target at least 4.5:1 contrast for normal text. Do not merely change the accent while leaving incompatible background/text colors. Provide both palettes.light and palettes.dark with matching paletteMode/current colors. Pair surfaces, popovers, text and accent roles rather than simply inverting colors. Keep action visibility, focus indicators, scrolling, click targets and Escape/revert usable.

Return exactly a version-1 `cryoclaw-theme` JSON package matching the skill schema. Preserve existing component adjustments unless the user requests a reset. Check numbers and color formats, then call the preview helper. Explain the visible changes in at most three sentences, and accurately distinguish preview from saved state.

Prefer semantic palette roles (`userBubble`, `assistantBubble`, `userText`, `assistantText`, `composer`, `input`, `icon`, `border`) for changes that should follow every conversation. Use inspected component IDs for local geometry and icon stroke/size changes. Keep unrequested roles inherited, retain clear focus and disabled states, and never hide quota or action controls. A default light appearance uses pure white; do not introduce a beige wash unless requested. Check short messages, long messages, an empty composer and the dark counterpart before reporting success.

If preview fails, use the bounded recovery procedure in SKILL.md, correct only your temporary package or invocation, and verify another preview before reporting success.
