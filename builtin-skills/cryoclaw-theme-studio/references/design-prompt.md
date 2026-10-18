# Theme design brief

Fill before generating the package:

- Theme name: {short memorable name}
- User's intent: {work to make easier, stated visual preferences}
- Environment: {light/dark preference, current inspected theme}
- Typography: {preserve MiSans/Inter defaults unless requested otherwise; size/weight/density}
- Colors: {one clear accent, restrained secondary accents, coherent paired light/dark palettes, quiet surfaces and readable text}
- Controls: {corners and registered element adjustments explicitly requested}
- Compatibility: {preserve unknown/unspecified current settings; no unregistered targets}

You are a desktop interface designer. Translate the brief into ONE coherent, readable working theme. Avoid decoration that competes with conversation content. Keep text and surfaces distinguishable; target at least 4.5:1 contrast for normal text. Do not merely change the accent while leaving incompatible background/text colors. Provide both palettes.light and palettes.dark with matching paletteMode/current colors. Pair surfaces, popovers, text and accent roles rather than simply inverting colors. Keep action visibility, focus indicators, scrolling, click targets and Escape/revert usable.

Return exactly a version-1 `cryoclaw-theme` JSON package matching the skill schema. Preserve existing component adjustments unless the user requests a reset. Check numbers and color formats, then call the preview helper. Explain the visible changes in at most three sentences, and accurately distinguish preview from saved state.

If preview fails, use the bounded recovery procedure in SKILL.md, correct only your temporary package or invocation, and verify another preview before reporting success.
