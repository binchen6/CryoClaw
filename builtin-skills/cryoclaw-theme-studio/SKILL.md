---
name: cryoclaw-theme-studio
description: Design and preview CryoClaw themes through the live desktop theme API. Use for app colors, typography and layout; never edit source or inject CSS.
metadata: {"openclaw":{"emoji":"🎨","os":["darwin","linux","win32"]}}
---

# CryoClaw Theme Studio

Use this skill for themes of the CryoClaw application itself. The app must be open.

1. Run `scripts/theme-client.mjs inspect` with the bundled runtime in `CRYOCLAW_NODE_BIN` (fall back to `node` only when that variable is absent). Enable Electron's Node mode for this subprocess: on PowerShell use `$env:ELECTRON_RUN_AS_NODE='1'; & $env:CRYOCLAW_NODE_BIN "<skill-dir>/scripts/theme-client.mjs" inspect`; on POSIX use `ELECTRON_RUN_AS_NODE=1 "$CRYOCLAW_NODE_BIN" "<skill-dir>/scripts/theme-client.mjs" inspect`. Substitute the actual skill directory from its location, preserving quotes around paths.
2. Read `references/design-prompt.md`. Fill the brief from the user's request; when the message comes from Appearance → Let your agent design a theme, it already carries the filled template (style, colors, light/dark preference, corners, typography, must keep, avoid, extra, preview mode) plus any reference-image attachments. Preserve unspecified layout and font settings from inspection. Treat these messages as a concrete request to complete the entire generate-and-preview workflow. Generate only the documented theme JSON; never raw CSS, HTML, selectors, scripts, remote resources or credentials.
3. Write the JSON to a temporary file under the state directory's `tmp/theme-studio/` or another task scratch directory. Do not overwrite project or existing theme files.
4. Run `theme-client.mjs preview <absolute-json-path>`. Only a successful response proves that the desktop applied the preview. The preview restores after 60 seconds; tell the user to click **保留主题 / Keep theme** to save or **撤销 / Revert** to undo. Never claim it was saved automatically.
   Before preview, check the five text/background pairs in the design brief for each variant. Use one inspect and one preview for a normal request; repeat only to repair a specific validation failure or fulfill a revision. Report the theme name, the two most visible changes and the Keep/Revert action in at most three sentences. Do not repeat the brief or output the full package into chat.
5. Revise via another preview when requested. `theme-client.mjs restore` cancels the current preview. After the user clicks Keep theme, the app applies the theme and adds it to the local theme library with an Agent design label; this does not happen during preview. The app's visual editor can select and drag individual controls; obtain its registered component IDs from inspection or a theme exported by the user before adjusting individual elements.

The helper reads the local control port and token privately; never print, paste, upload or include those values in generated files. Do not work around an unavailable app or a rejected theme by editing configuration files directly.

Read [theme package](references/theme-package.md) when writing a package or interpreting an Appearance brief. Keep the two palettes, role colors, contrast rules and bounded component schema; the reference contains the exact fields.
