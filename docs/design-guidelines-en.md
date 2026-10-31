# CryoClaw Design Guidelines (2026.9 R2 brand refresh)

CryoClaw uses **CryoBlue `#1A6FD0`, quiet neutral surfaces, and MiSans/Inter typography**.
Default CryoBlue is restored, with restrained green secondary accents. Each built-in theme pairs
its own light and dark surfaces. Primary controls follow the selected accent, with readable foregrounds. See [VISUAL-SYSTEM.md](VISUAL-SYSTEM.md) for the current specification;
it supersedes historical stage values below. This document mirrors
the current code; the sources of truth are `shared/design-tokens.css`,
`chat-ui/ui/src/styles/tokens-ext.css`, `chat-ui/ui/src/styles/primitives.css`,
`chat-ui/ui/src/ui/icons.ts` (the CryoIcons self-drawn icon system), and the binding contract
`docs/archive/ui-rewrite-2026.9-contract.md` (completed, archived) — when in doubt, the code and the contract win.

## 1. Principles

1. **Always use design tokens. Never hardcode hex** (e.g. `color: #fff`), never hardcode
   `border-radius` / spacing / font-size / shadow values, never `transition: all` (list
   explicit properties). Sole exception: rgba semantic colors are allowed, but must compose
   token variables (e.g. `color-mix(in srgb, var(--destructive) 18%, transparent)`).
2. **All theme differences live in tokens.** View CSS must **not** contain `[data-theme=]`
   override blocks or `@media (prefers-color-scheme)` blocks — dark definitions exist only
   in `design-tokens.css` and `tokens-ext.css` (two channels: the `[data-theme=dark]`
   primary channel plus the `prefers-color-scheme` fallback). No view stylesheet in the
   repo currently has such blocks; adding one means rework.
3. **Reuse the `.btn` / `cc-*` primitives first** (see §5); do not invent new
   button/card/dialog styles.
4. **No `text-transform: uppercase`**: labels render as written — respect brand casing and
   CJK text. Exception: session-panel group labels
   (`oc-panel__group-label`) keep the component contract's uppercase + caps tracking.
5. **Boolean settings always use the iOS-style Switch** (`<oc-toggle-switch>`, label left,
   switch right) — not radio buttons or checkboxes.
6. **Default action buttons align right**: dialog footers and settings button rows use
   `justify-content: flex-end` (built into `cc-dialog__foot`); only inline list-local
   actions may deviate.
7. **Metadata always uses mono small text**: model labels, tool names, token usage,
   timestamps, paths, status lines use `var(--font-meta)` + `var(--font-size-meta)` (11px),
   dimmed with `var(--text-muted)` / `var(--text-faint)`. Hierarchy comes from the grey
   scale + font weight, not stacked cards.
8. **Converged radii, no pill buttons**: buttons/inputs/menu items radius-8, cards/
   popovers/toasts radius-12, dialogs radius-16; `--radius-pill` / `--radius-full` are
   reserved for small indicator elements (badges, tags, chips) — buttons are no longer
   capsules.
9. **Components have no Shadow DOM** (`createRenderRoot() { return this; }`) — all styles
   live in global CSS; no new npm dependencies; icons always come from the CryoIcons
   self-drawn system (`icons.ts`, spec in §6) — draw new ones per that spec instead of
   adding a third-party icon library.

## 2. Token system

Tokens come in two layers: **base layer `shared/design-tokens.css`** (the global single
source of truth — standalone pages also `@import` it) + **Chat UI extension layer
`chat-ui/ui/src/styles/tokens-ext.css`** (shell-size variables + compat aliases). Token
names were kept unchanged in the 2026.9 rewrite (zero rename cost downstream); the values
were fully retuned.

### 2.1 Static tokens (theme-independent, `design-tokens.css`)

- **Radius scale**: `--radius-2/4/6/8/10/12/16/20/24/32`; compat aliases
  `--radius-xs/sm/md/lg/xl` (= 4/8/12/16/20), `--radius-pill` (999px).
- **Spacer scale** (4px base grid): `--spacer-2/3/4/6/8/10/12/16/20/24/32/40/48/64`.
- **Icon sizes**: `--icon-size-12/14/16/20/24`.
- **Reading column widths (R84 fluid)**: `--chat-column` (`min(92%, 1000px)` — centered
  column for the message stream and compose box), `--ext-column` (`min(92%, 1200px)` —
  content column for extension views), `--page-column` (`min(92%, 1080px)` — content
  column for settings/tasks form pages). Columns fill ~92% of available width and
  stretch with the window; the pixel cap only binds on very wide windows.
- **Font stacks**: `--font-body` (Inter + SF Pro Text + PingFang SC fallback),
  `--font-display`, `--mono` (JetBrains Mono family), `--font-meta` = `--mono`;
  `--font-size-meta: 11px`, `--font-size-body: 14px`.
- **Type scale**: body `--text-2xs/xs/sm/base/lg` (10/11/12.5/14/18), headings
  `--heading-xs/sm/md/lg/xl/2xl/3xl` (13/15/18/20/24/28/32), display (large hero titles
  on empty states) `--display-sm/md/lg` (26/32/40).
- **Letter spacing**: `--tracking-display` (-0.03em), `--tracking-tight` (-0.02em),
  `--tracking-body` (-0.011em), `--tracking-wide` (0.04em), `--tracking-caps` (0.08em,
  badges/group labels).
- **Line height**: `--leading-tight/1.25`, `--leading-title/1.35`, `--leading-body/1.6`,
  `--leading-relaxed/1.75` (assistant body text).
- **Font weight**: `--weight-regular/medium/semibold/bold` (400/500/600/700).
- **Motion**: `--ease-out/--ease-in-out/--ease-standard/--ease-spring`, duration scale
  `--duration-instant/fast/normal/slow/slower` (0.08/0.12/0.2/0.35/0.5s; instant = micro-
  feedback swaps, fast = hover/press, normal = panels/entrances, slow = card entrances,
  slower = large transitions); loop indicators (pulse/spin/shimmer infinite loops) all use
  `--duration-loop` (1.2s); stagger entrance delays use `--delay-step` (50ms,
  `.stagger-1..6` = steps 0–5 via calc).
- **Glass blur**: `--glass-blur-sm/md` (8/16px, pairs with the `--glass-*` backgrounds
  for backdrop-filter).

### 2.2 Palette

- **Brand CryoBlue scale** (original CryoBlue tonal scale):
  `--brand-50 … --brand-950` (`#eef6fd` … `#0f2a4e`), light-theme primary
  **`--brand-600: #1a6fd0`** (≈4.95:1 on white, passes AA), base `--brand-500: #2a89dd`.
- **Neutral grey scale** (zero hue, Notion-style paper feel): `--grey-50 … --grey-950`
  (`#fafafa` … `#0a0a0a`).
- Semantic colors: `--ok` (`#16a34a`), `--destructive` (`#dc2626`), `--warn` (`#d97706`),
  `--info` (= brand), each with `-muted` / `-subtle` variants; in dark mode the semantic
  colors brighten individually (`#4ade80` / `#f87171` / `#fbbf24`).
- **Secondary accent cyan**: `--accent-2` (defined in tokens-ext; `#0891b2` light,
  `#22d3ee` dark, with `-muted`/`-subtle`) — only for second-emphasis spots like worktree
  badges; never replaces the primary accent.

### 2.3 Theme variables (light default / dark independently tuned)

Light and dark are **two first-class themes**: text contrast, shadow depth, and glass
parameters are each defined per theme — dark is not derived from light.

- Backgrounds: `--bg`, `--bg-secondary`, `--bg-elevated`, `--bg-hover`, `--bg-input`,
  `--bg-muted`. Light = paper-white tiers (`#ffffff` / `#fafafa`); dark = four near-black
  neutral depth steps (`#101012` / `#17171a` / `#1e1e22` / `#26262b`).
- Text: `--text`, `--text-strong`, `--text-secondary`, `--text-muted`, `--text-faint`,
  `--text-on-accent` (five-step neutral grey).
- Borders: `--border`, `--border-strong`, `--border-hover`, `--border-focus`; hairline
  shortcuts `--hairline` / `--hairline-strong` (1px solid border color) — always prefer
  hairlines for separation, no heavy divider lines.
- Accent: `--accent` (light = brand-600 `#1a6fd0`, dark brightens one step to brand-400
  `#4ba4e6`), `--accent-hover` (brand-700 / brand-300), `--accent-subtle`,
  `--accent-glow` (stronger glow in dark to lift the dark scene).
- Overlay/glass: `--overlay(-heavy)`, `--glass-xs/sm/md/lg`, `--glass-border`
  (light = dark pressed layer, dark = white lifted layer — two independent parameter sets).
- Card top highlight: `--highlight-inset` (bright edge in light / faint white edge in
  dark).
- Shadows: `--shadow-xs/sm/md/lg/xl` (light: low-alpha multi-layer, restrained; dark:
  higher alpha, deeper and more solid). Usage: cards `--shadow-xs/sm`, popovers/menus
  `--shadow-lg`, dialogs `--shadow-xl`.
- Dark is defined twice with identical variable sets: `:root[data-theme=dark]` (Chat UI
  primary channel) and `@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) }`
  (fallback for standalone pages such as Settings/Setup iframes). Both set
  `color-scheme`.

### 2.4 Chat UI extension variables (`styles/tokens-ext.css`)

- **Shell-size variables (static)**: `--rail-width: 68px` (labeled icon rail, always present
  except in setup), `--panel-width: 264px` (session-panel default width; overridden
  inline on `:root` once the user resizes), `--titlebar-h: 44px` (immersive
  titlebar/context-bar height — the shell reserves it uniformly), `--toggle-knob`
  (switch knob, white in both themes), `--radius` / `--radius-full` aliases.
- **Focus ring**: `--ring` = `--accent`; focus is a three-tier token set (see §9
  Focus system): `--focus-field` (inputs), `--focus-ring` (compact controls),
  `--focus-ring-inset` (dense rows); `--focus-glow` adds a 16/20px glow on top.
- **Compat aliases**: `--card(-foreground/-highlight)`, `--popover(-foreground)`,
  `--panel(-strong/-hover)`, `--chrome(-strong)`, `--muted(-strong/-foreground)`,
  `--input`, `--primary(-foreground)`, `--secondary(-foreground)`,
  `--danger(-muted/-subtle)`, `--accent-muted`, `--accent-foreground`, `--bg-accent`,
  `--bg-content`, `--chat-text`, `--grid-line`, `--shadow-glow`, etc. — all map onto the
  design-tokens semantic tokens. New code should prefer the semantic variables in §2.3;
  the alias layer exists for legacy compatibility — do not expand it.
- **First-frame flash prevention**: the `:root` defaults are **light** (light systems
  don't flash a dark first frame); dark values are defined through two channels —
  `[data-theme=dark]` plus the `prefers-color-scheme: dark` fallback block — so dark
  systems no longer flash white before `data-theme` lands.

### 2.5 Spacing/layout utility classes (`styles/utilities.css`)

Incidental spacing needs in view TS always use the utility classes — flex skeleton
(`oc-flex(-col)` / `oc-items-{start,center}` / `oc-justify-{end,between}` /
`oc-flex-wrap` / `oc-flex-1`), gaps (`oc-gap-{2…24}`), margins (`oc-m{t|b|l|r}-{2…32}`,
`oc-m{l|r}-auto`, `oc-m-0`), padding (`oc-p-{8…24}`) — with values from the `--spacer`
scale (check the file for the live set; dead classes are pruned). Functional styles
(sizing, colors, positioning, dynamic values) are out of scope — keep them in CSS blocks.

## 3. Theme & color usage

- The brand baseline `--brand` uses original CryoBlue; `--accent` is the customizable theme ink
  only; red/green/amber are semantic status colors only (error/ok/warn), never theme colors.
- Large white space + hairline dividers + subtle tonal separation instead of hard lines;
  hover feedback = slight background tint (`--bg-hover`) + stronger border
  (`--border-strong`). Section spacing ≥ `--spacer-24`.
- The old "indigo brand `#6366f1`", the older "ice-blue brand `#0EA5E9`", and the even
  older "signature red `#c0392b`" rules are all retired — do not reference them.
- **Theme-adaptation red line (restated, hard rule)**: view CSS contains no
  `[data-theme=]` override blocks, no `@media (prefers-color-scheme)` blocks, no
  hardcoded color values — all theme differences are carried by the tokens above.

## 4. App shell layout (2026.9 proposal A)

```
┌────────┬──────────────┬──────────────────────────────────┐
│        │              │  .cryoclaw-titlebar (44px, drag)   │
│ oc-rail│oc-session-   │  = context bar: panel toggle +     │
│ (68px) │panel(264px,  │    session name / view title       │
│ always │collapsible/  ├──────────────────────────────────┤
│  on)   │resizable)    │  .cryoclaw-content                 │
│        │  chat view   │  (per-view content)                │
│  rail  │  only        │                                    │
└────────┴──────────────┴──────────────────────────────────┘
```

### 4.1 oc-rail icon rail (`shell.css`)

- Width `--rail-width` (68px), present in every view except the setup fullpage wizard;
  the whole rail is a drag region, every interactive item is `no-drag`.
- Top to bottom: brand mark (drag area) → chat / dashboard / tasks (running-task count badge) /
  workspace / extensions → flexible spacer (`oc-rail__spacer`) → webbridge repair
  (conditional, warn color) → full web version / reconnect (destructive color + error
  badge when disconnected; hovering pops up the `oc-rail__error-popup` error list) →
  settings (with dot badge `oc-rail__dot`).
- Primary items are 48×48 with radius-10, a 19px icon and a short text label; secondary
  icon-only items remain 40×40. Default `--text-muted`, hover shows `--bg-hover` tint,
  active = `--accent` text + `--accent-subtle` background.
- The numeric badge `oc-rail__badge` (accent background, destructive when disconnected)
  and the dot badge `oc-rail__dot` are among the few legitimate pill-radius uses.

### 4.2 oc-session-panel session panel (`session-panel.css`)

- **Shown only in the chat view**; the `navCollapsed` setting now means "session panel
  collapsed". The collapse/expand button sits at the left of the context bar
  (`cc-contextbar__toggle`).
- Default width `--panel-width` (264px); the right-edge resize handle
  `.cryoclaw-panel-resize` (6px hit zone, accent indicator bar on hover/active) drags
  the width within **220–420px**, persisted to the `sidebarWidth` setting (semantics
  unchanged; the CSS variable is now `--panel-width`, user values applied as an inline
  override on `:root`).
- Narrow-window adaptation (only when the user has not customized the width):
  ≤900px → 232px, ≤720px → 220px.
- Structure: panel header (title + more / archive toggle) → full-width New chat primary
  button → search box → session list (the only scroll container; group labels +
  session items + unread dot / pin / worktree badge + inline rename + "⋯" management
  menu, z-index ≤60).

### 4.3 Context bar & titlebar offset

- `--titlebar-h: 44px` unchanged; `.cryoclaw-titlebar` is reserved uniformly by the
  shell (`.cryoclaw-main`) — **views no longer add their own 44px top offset** (old
  `padding-top: var(--titlebar-h)` patterns were removed).
- The titlebar area is `-webkit-app-region: drag`; every interactive element inside
  must be `no-drag` (drag/no-drag pairing).
- Content: chat view = panel toggle + session title; other views = view title
  (`cc-contextbar__title`, `--heading-sm` semibold). View-specific actions live in the
  content area, not in the titlebar.
- **setup is the only fullpage view**: no rail, no context bar.

### 4.4 z-index three-tier contract (hard rule)

In-view menus/popovers **≤60**; titlebar/context bar **100**; modals/toasts/confirm
boxes **≥1000** (`cc-dialog-overlay` = 1000, `global-toast` = 10001). No other values.

### 4.5 Window behavior (`src/window-bounds.ts`)

- First launch default size = **80%** of the primary display's work area; minimum
  constraint **800×600** (`src/constants.ts`).
- User-adjusted bounds persist to `userData/window-bounds.json` and are restored on the
  next launch; before restoring, they are validated: size ≥ minimum constraint, and
  sufficient overlap with at least one display's work area (≥160px wide, ≥48px tall) —
  so unplugging an external monitor can't restore the window into an invisible region.
  Failed validation falls back to the default size.

## 5. Component spec

### 5.1 Buttons (`.btn` three-tier system, `primitives.css`)

Since 2026.9 the `.btn` system lives in `primitives.css` (the old sidebar.css global
pill-ification `!important` overrides were deleted). Uniform spec: **height 32,
radius-8, weight 500, built-in 16px icons**; focus-visible = `--focus-ring`; disabled =
opacity 0.5.

| Class | Tier | Appearance |
|---|---|---|
| `.btn.primary` | Primary action (at most one per screen) | solid `--accent` + `--text-on-accent`, hover `--accent-hover` |
| `.btn` (default) | Secondary | `--bg-elevated` + hairline border |
| `.btn.danger` | Destructive | since R85: `color-mix(destructive 10%)` background + 28% semantic border + `--danger` text (the old 8% borderless tint was too faint); hover deepens to 16%/38% |

Modifier: `.btn--sm` (height 28, padding 10, font `--text-sm`).
(R75: the zero-reference `cc-btn` kit plus `.btn.secondary`/`.btn.ghost` were removed from primitives.css.)
(R85 lesson: never append an extra slash after a CSS block comment terminator — the stray slash contaminates the next selector and browsers silently drop the rule; build-time `assertCssSelectorsValid` + `css-syntax-qa.test.ts` guard it, see gotchas #105.)

### 5.2 Form controls

Form controls use per-component classes plus the `.field` system in `components.css`:
**32px high, `--bg-input` background, hairline border, radius-8**; focus = `--focus-field-color` border + `--focus-field` halo (§9 Focus system); placeholder/disabled use `--text-muted`.
`.field` = label (`--text-sm` medium muted) + control in a grid.
The chat composer is the reference implementation of that same focus language (accent-mixed border + soft halo), not an exception.
(R75: the zero-reference `cc-input`/`cc-select`/`cc-textarea` were removed.)

### 5.3 Cards (`.card`)

`--card` background + hairline border + **radius-12** + `--shadow-xs` + padding-20;
`.card` plays a rise entrance animation, hover deepens the border + `--shadow-sm`.
(R75: the zero-reference `cc-card` was removed; clickable cards use component classes.)

### 5.4 Dialogs (`cc-dialog` contract)

`cc-dialog-overlay` (fixed full-screen, `--overlay` backdrop, z-index 1000, centered,
padding-24) + `cc-dialog` (`--popover` background, hairline, **radius-16**,
`--shadow-xl`, max-width 520). Sections: `__head` (`__title` = `--heading-sm` semibold
+ `__close` 32×32 icon button) / `__body` (`--text-secondary`) / `__foot` (buttons
right-aligned, gap-8).

### 5.5 Global toast (`global-toast`)

**Bottom-centered and clears the actual composer height**: `fixed; bottom: calc(24px + var(--chat-compose-clearance, 0px)); left: 50%`, `--bg-elevated`
background + hairline + radius-12 + `--shadow-lg`, `--text-sm` medium, z-index 10001,
`--duration-normal` rise-in and continuous repositioning as composer height changes. Defaults to `pointer-events: auto` and auto-dismisses;
the `global-toast--action` variant (e.g. "restart to update") never auto-dismisses and carries a small accent-outlined button `global-toast__action` on the right.

### 5.6 Other primitives quick reference

| Class | Purpose | Variants / notes |
|---|---|---|
| `cc-tag` | Badge, height 22, pill radius | `--brand` (subtle bg + brand text) |
| `cc-alert` | Alert bar, 3px semantic left border | `--warn` / `--error` |
| `.callout` | Callout block (subtle bg) | `.danger` / `.info` |
| `.code-block` | Code block | `--mono` + `--bg-muted` + radius-8 |
| `.compaction-indicator` | Compaction indicator pill in the message stream | `--active` / `--complete` / `--fallback` |

The Switch is not in primitives: use the `<oc-toggle-switch>` component
(`ui/components/toggle-switch.ts`, iOS style, knob is white in both themes).

## 6. Icon system (CryoIcons, self-drawn)

Since the 2026.9 R2 refresh, **all app icons are drawn in-house**
(`chat-ui/ui/src/ui/icons.ts` plus the file-card icons in
`chat-ui/ui/src/ui/chat/media-enhance.ts`) — zero third-party icon-library dependencies.

### 6.1 Drawing spec (hard rules)

- **Canvas**: `viewBox="0 0 24 24"`, content inside the ~2.5–21.5 safe area.
- **Stroke**: `stroke="currentColor"`, `stroke-width="1.75"`, `stroke-linecap="round"`,
  `stroke-linejoin="round"`, `fill="none"`; icons always inherit text color — never
  hardcode a color.
- **Geometry language**: pure primitives — straight lines, circles/arcs, rounded
  rectangles (rx 1.2–2). No stacked fills, no gradients, no drop shadows.
- **The only two fill exceptions**: `moreHorizontal` dots (small `fill="currentColor"`
  circles) and `pinActive` (whole-shape fill as the single "active" visual difference).
- **Semantics over pictorial complexity**: prefer simple geometry (e.g. settings = center
  circle + 8 spokes); icons must stay legible at their 16–20px display size.
- Coordinates snap to 0.5 steps (pixel-alignment friendly); icon families share visual
  weight and stroke density.

### 6.2 Usage & extension

- Views reference icons only via `icon(name)` / `icons.<name>` (`icons.ts` exports the
  `IconName` type; the key names are the contract — no ad-hoc inline SVG).
- File-card icons come from `ICON_BY_CATEGORY` (media-enhance.ts), following the same
  spec as `icons.ts`.
- Adding an icon: draw per §6.1 → register in `icons.ts` → run the chat-ui tests
  (`grouped-render.test.ts` audits that unsafeSVG is used only for static icons).
- Default icon sizes follow the `--icon-size-*` scale (16/20 dominate); never hardcode a
  size inside the icon itself.

## 7. Style organization

- **The hub `chat-ui/ui/src/styles.css` only `@import`s; cascade order is load-bearing —
  never reorder casually**: design-tokens → tokens-ext → base → **primitives** →
  **utilities** → **shell** → **session-panel** → chat / components / panels / skills /
  compose / workspace / cron / chat-misc / tasks-misc / settings-misc / panel / plan →
  (last) **settings → setup**.
- Since 2026.9 the old `sidebar.css` is split into `shell.css` (shell / icon rail /
  context bar / resize handle) + `session-panel.css` (session panel);
  `shell.css` / `session-panel.css` / `design-tokens.css` / `tokens-ext.css` /
  `base.css` are owned by the main agent — view tasks must not touch them.
- `styles/settings.css` (settings page) and `styles/setup.css` (setup wizard) were
  extracted from view-TS adoptedStyleSheets-injected styles; those used to outrank
  document stylesheets, so they must stay **last** in the import list.
- View styles may override primitives (primitives sit after base and before view
  styles — intentional).
- New styles: first try composing tokens + existing primitives; if you must add CSS,
  put it in the matching split file; new colors/radii/spacing go into
  `design-tokens.css` first.
- Standalone pages (`setup/webbridge-enable-guide.html`, etc.) also `@import`
  shared/design-tokens.css and get the dual-channel themes for free.

## 8. Layout conventions

- The 44px titlebar is reserved by the shell (see §4.3); floating layers anchor to
  `--titlebar-h` (e.g. `top: calc(var(--titlebar-h) + var(--spacer-12))`).
- Centered column constraints (R84 fluid): message stream / compose use `--chat-column`
  (`min(92%, 1000px)`); extension-view content columns use `--ext-column`
  (`min(92%, 1200px)`); form pages use `--page-column` (`min(92%, 1080px)`).
- Narrow windows (≤900px / ≤720px) get session-panel width media queries (see §4.2).
- Grid overflow guard: `grid-template-columns: minmax(0,1fr)` + `min-width: 0` on
  children.

## 9. Accessibility

### Focus system (unified 2026-10-30)

One sentence defines the focus language: **a single accent-tinted edge plus a very light halo — never a hard stroke.** All tokens live in `styles/tokens-ext.css` and are picked by *element-to-background relationship*, not per page:

| Token | Applies to | Shape |
|---|---|---|
| `--focus-field-color` + `--focus-field` | Text input surfaces (input / textarea / select / search / inline rename) | Border mixed from `accent 45%` and `--border`, plus a 3px `--accent-subtle` halo |
| `--focus-ring` | Compact controls: buttons, icon buttons, menu items, chips, card entries | 2px inner `accent-subtle` + 3px `--ring` outer edge |
| `--focus-ring-inset` | Rows inside dense lists/tables (session items) | `inset` stroke — no bleed into neighbours, no layout shift |

- The chat composer (`.chat-compose__field:focus-within`) is the **reference implementation** and now references `--focus-field-color` / `--focus-field` directly, so changing the token changes it too instead of drifting.
- No more `outline: 2px solid <color>` for focus (outline does not follow `border-radius`, leaving square corners on rounded controls). The global `:focus-visible` baseline in `base.css` is `outline: none` + `box-shadow: var(--focus-ring)`.
- Pointer focus shows no ring (`:focus:not(:focus-visible)` clears the shadow); keyboard and programmatic focus do.
- Colour/ring transitions use `--focus-transition` (`--duration-fast` + `--ease-standard`); do not reintroduce `--ease-out`.
- Solid outlines stay legal for **selection state** only (a dashboard card or element selected while editing) — that is selection semantics, not focus, and the regression test separates the two by selector.
- Regression: `chat-ui/ui/src/ui/focus-system.test.ts` pins token completeness, absence of leftover hard strokes, input adoption of `--focus-field`, and inset strokes for dense lists.

- **Unified focus ring**: global `:focus-visible { box-shadow: var(--focus-ring) }`
  (base.css); individual controls redeclare the same token. Do not write custom outline
  styles, and never remove focus styles without a replacement.
- **`prefers-reduced-motion`**: base.css globally collapses animations/transitions to
  instant (0.01ms + single iteration) and disables the theme-switch view-transition;
  component level (skeleton shine, loading spinners, resize-handle indicator) has its
  own reduced-motion blocks — register new animations in the same pattern.
- Motion-duration conventions: hover/press use `--duration-fast`, panel open/close and
  entrances use `--duration-normal`, all on `--ease-standard` (the recommended value;
  stop adding new `--ease-out` uses); infinite loops (pulse/spin/shimmer) always use
  `--duration-loop`; popover/dialog scale entrances use `--ease-spring`.
- Drag-region discipline: large shell surfaces are `-webkit-app-region: drag` so the
  window stays draggable; every interactive element must pair with `no-drag` to stay
  keyboard/mouse reachable.

### Directional peer navigation (2026.10.31)

Top-level views, settings tabs, task tabs and the three provider views share one directional language instead of mixing upward entrances, horizontal slides and hard cuts:
- Forward navigation fades the new page in 8px from the right; backward navigation enters 8px from the left. The old page moves only 4px in the corresponding direction while fading out. Use `--duration-normal` and `--ease-standard` without blocking interaction.
- `transitionView` derives direction from the view/tab positions before and after navigation. Rapid changes settle on the latest page; business state never waits for an animation.
- Lit keyed nodes and native view-transition snapshots share the `oc-nav-*` keyframes, preventing two competing motions for one navigation. Animate only opacity/transform; do not add layout reads or persistence work.
- Reduced motion shows the final state immediately. Direction must never affect keyboard focus, hit testing or data loading.

### Project motion principles (2026-10-23)

Motion should be precise, natural and beautiful across transitions, interruption, entrance and exit. Normal mode keeps the complete motion language; **never trade fewer animations for fluency**. Use compositing, visibility scheduling and less redundant work instead. Use fewer effects only when that improves reading. **Fluency takes priority over decoration.**
- `prefers-reduced-motion` is an explicit accessibility preference, never a default performance strategy; normal-mode animation must not be silently removed for performance.

- Preserve element identity and state. Reverse from current visual geometry; never flash back to the starting state or reload an iframe to animate it.
- Prefer transform/opacity, coalesce pointer updates per frame, and commit the final pointer position. Avoid per-frame layout writes, Canvas reallocations, persistence or model requests.
- Let entrance explain origin and exit explain destination. Keep ambient motion quiet, and stop work offscreen or while the window is hidden.
- Reduced motion presents a stable final state with complete content and keyboard focus. Verify rapid reversals, repeated clicks, resizing, hidden/resume and keyboard use.

### Overlay return rules (2026-10-30)

Every overlay (popover, dropdown menu, floating panel, dialog) follows "return where you came from, one continuous take, along the original path, naturally":

- **Reversible.** Re-triggering the control that opened an overlay must close that same overlay; repeated activation toggles symmetrically. Any entry point that can only open, never close, is a bug. Native `popover="auto"` overlays must bind their trigger with the declarative `popovertarget` invoker (invokers are exempt from light dismiss); never hand-write `showPopover()/hidePopover()` in a click handler — pointerdown light-dismiss closes first, then the click reopens it, so it appears impossible to close.
- **Return along the original path.** Exit mirrors entrance: same anchored edge, same direction, same distance. Use a leaving class plus delayed DOM removal, or `display`/`overlay` `allow-discrete` transitions; keep `transform-origin` on the anchored corner so a panel opening upward enters from its bottom edge and leaves the same way.
- **Adaptive anchoring.** Position overlays relative to their trigger and flip/clamp inside the viewport instead of overflowing it; never cover the trigger itself and avoid covering the adjacent primary action (e.g. 新建对话 in the session panel header). All placement goes through `utils/popover-placement.ts` `placePopover()` — no per-component hardcoded `left`/`bottom`.
- **One close path.** Escape, outside click and item selection share one exit and teardown; focus returns to the trigger (or the previously focused element), `aria-expanded` resets, and reopening mid-exit continues from the current geometry.
- **Acceptance.** Walk through repeated clicks, mid-way reversal, minimized window, keyboard (Tab/Enter/Esc/arrow keys) and reduced motion; `npm run test:chat` must cover second-click close and viewport clamping, not just the first open.

**Registered exceptions** — these deliberately do not follow the rule above; keep their existing semantics when editing:
- The conversation info panel (`views/conversation-info.ts`) is a **docked** contextbar panel rather than an anchored one; it already has Esc, outside click and X wired to one close path with focus restore.
- Dashboard expanded cards (`popover="manual"` in `oc-dashboard.ts`) and the global toast are not click-toggled surfaces, so clause 1 does not apply; they still keep a reverse morph / exit frame.
- Native `<dialog>` surfaces (provider edit drawer, dashboard detail) get Esc/backdrop/initial focus for free; only add the `cc-dialog-out` exit from `skills.css`, never a hand-written toggle.

## 10. Tooltip

- **No CSS `::after` pseudo-element tooltips** (always clipped inside `overflow`
  containers). Use the global `position: fixed` `.fixed-tooltip` element plus the
  `data-tooltip="text"` attribute; `data-tooltip-pos="bottom"` flips direction; long
  text uses `.fixed-tooltip--wide`.
- **Tooltips only on icon-only buttons** (rail items are the canonical case);
  buttons/menu items with text labels get none.

## Independent dashboard workspace

- Tab context menus have exactly two actions: edit details and delete. Current title/description inform the model; avoid a duplicate metadata bar.
- One persistent pencil dock toggles model, layout and content editing; a second click exits and keeps the draft. Move the dock above the actual composer height. More actions owns Add module.
- Widgets receive real dimensions. Responsive defaults and continuous manual sizing coexist; manual width keeps its free flag. Arrange preserves reading order and full-width anchors, balances rows and offers geometry undo.
- Expansion uses the browser top layer without replacing the iframe, input, timer or local state. Focus mode clears the native titlebar. Outer cards have no hover translation, scale or focus effect.
- Interactive template previews use an isolated HTTP sandbox with labeled sample data, no external network, real state writes or model requests. Changing preview size retains its state.
- Element editing binds to the owning card and intercepts original control actions and text input. Pause hidden motion, honor reduced motion, and avoid per-frame layout reads or persistence.
