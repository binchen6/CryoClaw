# CryoClaw Design Guidelines (2026.9 R2 brand refresh)

CryoClaw's design language = **neutral grey + the CryoBlue blue-cyan blended accent**
(Linear/Notion-style clean and modern). The brand color is a calm, work-oriented blue shifted
towards cyan (self-drawn CryoBlue scale; light-theme primary `#1a6fd0`, secondary cyan
`#0891b2`) — cool, trustworthy, lively yet never garish, easy on the eyes for long sessions.
The signature gradient (blue→cyan `#2a89dd → #06b6d4`) is reserved for brand moments
(logo / website hero / installer); inside the UI only the solid accent is used. Light is the
default first-class theme; dark is an independently tuned near-black neutral theme. The two themes
are defined separately at the token layer — dark is not "light plus a patch". This document mirrors
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
   CJK text. Exceptions: the `cc-table` header and session-panel group labels
   (`cc-panel__group-label`) keep the component contract's uppercase + caps tracking.
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
- **Reading column widths**: `--chat-column` (760px — centered column for the message
  stream and compose box), `--ext-column` (960px — content column for extension views).
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
  `--duration-instant/fast/normal/slow/slower` (0.08/0.12/0.2/0.35/0.5s),
  `--transition: 180ms ease`.
- **Glass blur**: `--glass-blur-sm/md` (8/16px, pairs with the `--glass-*` backgrounds
  for backdrop-filter).

### 2.2 Palette

- **Brand CryoBlue scale** (self-drawn blue × cyan blend, not a stock library scale):
  `--brand-50 … --brand-950` (`#eef6fd` … `#0f2a4e`), light-theme primary
  **`--brand-600: #1a6fd0`** (≈4.6:1 on white, passes AA), base `--brand-500: #2a89dd`.
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

- **Shell-size variables (static)**: `--rail-width: 60px` (icon rail, always present
  except in setup), `--panel-width: 264px` (session-panel default width; overridden
  inline on `:root` once the user resizes), `--titlebar-h: 44px` (immersive
  titlebar/context-bar height — the shell reserves it uniformly), `--toggle-knob`
  (switch knob, white in both themes), `--radius` / `--radius-full` aliases.
- **Focus ring**: `--ring` = `--accent`; `--focus-ring` =
  `0 0 0 2px var(--bg), 0 0 0 4px var(--ring)` (two-layer ring: background cutout +
  accent outer ring); `--focus-glow` adds a 16/20px glow on top.
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

- The accent is always the steady blue `--accent`; cyan `--accent-2` is second emphasis
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
│ cc-rail│cc-session-   │  = context bar: panel toggle +     │
│ (60px) │panel(264px,  │    session name / view title       │
│ always │collapsible/  ├──────────────────────────────────┤
│  on)   │resizable)    │  .cryoclaw-content                 │
│        │  chat view   │  (per-view content)                │
│  rail  │  only        │                                    │
└────────┴──────────────┴──────────────────────────────────┘
```

### 4.1 cc-rail icon rail (`shell.css`)

- Width `--rail-width` (60px), present in every view except the setup fullpage wizard;
  the whole rail is a drag region, every interactive item is `no-drag`.
- Top to bottom: brand mark (drag area) → chat / tasks (running-task count badge) /
  workspace / extensions → flexible spacer (`cc-rail__spacer`) → webbridge repair
  (conditional, warn color) → full web version / reconnect (destructive color + error
  badge when disconnected; hovering pops up the `cc-rail__error-popup` error list) →
  settings (with dot badge `cc-rail__dot`).
- Item spec: 40×40, radius-10, 20px icons; default `--text-muted`, hover shows
  `--bg-hover` tint, active = `--accent` text + `--accent-subtle` background.
- The numeric badge `cc-rail__badge` (accent background, destructive when disconnected)
  and the dot badge `cc-rail__dot` are among the few legitimate pill-radius uses.

### 4.2 cc-session-panel session panel (`session-panel.css`)

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
- Structure: panel header (title + icon buttons for new session / more / archive
  toggle) → search box → session list (the only scroll container; group labels +
  session items + unread dot / pin / worktree badge + inline rename + "⋯" management
  menu, z-index ≤60).

### 4.3 Context bar & titlebar offset

- `--titlebar-h: 44px` unchanged; `.cryoclaw-titlebar` is reserved uniformly by the
  shell (`.cryoclaw-main`) — **views no longer add their own 44px top offset** (old
  `padding-top: var(--titlebar-h)` patterns were removed).
- The titlebar area is `-webkit-app-region: drag`; every interactive element inside
  must be `no-drag` (drag/no-drag pairing).
- Content: chat view = panel toggle + session title; other views = view title
  (`cc-contextbar__title`, `--heading-xs` semibold). View-specific actions live in the
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
| `.btn` (default) / `.btn.secondary` | Secondary | default = `--bg-elevated` + hairline border; secondary = `--bg-muted` fill + hairline |
| `.btn.danger` | Destructive | `--danger-subtle` background + `--danger` text, borderless |
| `.btn.ghost` | Low-density auxiliary | transparent, hover shows `--bg-hover` |

Modifier: `.btn--sm` (height 28, padding 10, font `--text-sm`).
The `cc-btn` kit (`--primary/--secondary/--ghost/--danger`, `--sm`, `--loading`
leading spinner, `--disabled`) shares the same language and specs; existing code keeps
using it.

### 5.2 Form controls

`cc-input` / `cc-select` / `cc-textarea` and the `.field` system in `components.css`
are unified: **32px high (except textarea), `--bg-input` background, hairline border,
radius-8**; focus = `--border-focus` + `--focus-ring`; placeholder/disabled use
`--text-muted`. `.field` = label (`--text-sm` medium muted) + control in a grid.

### 5.3 Cards (`.card` / `cc-card`)

`--card` background + hairline border + **radius-12** + `--shadow-xs` + padding-20;
`.card` plays a rise entrance animation, hover deepens the border + `--shadow-sm`;
`cc-card--interactive` for clickable cards (hover `--shadow-md` + stronger border).

### 5.4 Dialogs (`cc-dialog` contract)

`cc-dialog-overlay` (fixed full-screen, `--overlay` backdrop, z-index 1000, centered,
padding-24) + `cc-dialog` (`--popover` background, hairline, **radius-16**,
`--shadow-xl`, max-width 520). Sections: `__head` (`__title` = `--heading-sm` semibold
+ `__close` 32×32 icon button) / `__body` (`--text-secondary`) / `__foot` (buttons
right-aligned, gap-8).

### 5.5 Global toast (`global-toast`)

**Bottom-centered** floating card: `fixed; bottom: 24px; left: 50%`, `--bg-elevated`
background + hairline + radius-12 + `--shadow-lg`, `--text-sm` medium, z-index 10001,
`--duration-normal` rise-in. Defaults to `pointer-events: none` and auto-dismisses;
the `global-toast--action` variant (e.g. "restart to update") restores clickability,
never auto-dismisses, and carries a small accent-outlined button
`global-toast__action` on the right.

### 5.6 Other primitives quick reference

| Class | Purpose | Variants / notes |
|---|---|---|
| `cc-tag` | Badge, height 22, pill radius | `--brand` / `--success` / `--warn` / `--error` (subtle bg + semantic text) |
| `cc-menu` / `cc-menu-item` | Popup menu | radius-12 + `--shadow-lg`; item min-height 32, radius-8 |
| `cc-alert` | Alert bar, 3px semantic left border | `--info` / `--success` / `--warn` / `--error` |
| `.callout` | Callout block (subtle bg) | `.danger` / `.info` |
| `cc-skeleton` | Skeleton | gradient shine; animation off under `prefers-reduced-motion` |
| `cc-table` | Table | subdued small uppercase header, hairline row dividers, row hover tint |
| `cc-tabs` / `cc-tab` | Tabs | underline indicator, `--active` |
| `cc-chip` | Chip (selectable, height 28) | `--selected` = accent border + subtle bg |
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
- **Stroke**: `stroke="currentColor"`, `stroke-width="2"`, `stroke-linecap="round"`,
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
- Centered column constraints: message stream / compose use `--chat-column` (760px);
  extension-view content columns use `--ext-column` (960px).
- Narrow windows (≤900px / ≤720px) get session-panel width media queries (see §4.2).
- Grid overflow guard: `grid-template-columns: minmax(0,1fr)` + `min-width: 0` on
  children.

## 9. Accessibility

- **Unified focus ring**: global `:focus-visible { box-shadow: var(--focus-ring) }`
  (base.css); individual controls redeclare the same token. Do not write custom outline
  styles, and never remove focus styles without a replacement.
- **`prefers-reduced-motion`**: base.css globally collapses animations/transitions to
  instant (0.01ms + single iteration) and disables the theme-switch view-transition;
  component level (skeleton shine, loading spinners, resize-handle indicator) has its
  own reduced-motion blocks — register new animations in the same pattern.
- Motion-duration conventions: hover/press use `--duration-fast`, panel open/close and
  entrances use `--duration-normal`, all on `--ease-out`.
- Drag-region discipline: large shell surfaces are `-webkit-app-region: drag` so the
  window stays draggable; every interactive element must pair with `no-drag` to stay
  keyboard/mouse reachable.

## 10. Tooltip

- **No CSS `::after` pseudo-element tooltips** (always clipped inside `overflow`
  containers). Use the global `position: fixed` `.fixed-tooltip` element plus the
  `data-tooltip="text"` attribute; `data-tooltip-pos="bottom"` flips direction; long
  text uses `.fixed-tooltip--wide`.
- **Tooltips only on icon-only buttons** (rail items are the canonical case);
  buttons/menu items with text labels get none.
