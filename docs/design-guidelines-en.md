# CryoClaw Design Guidelines (R3E rewrite)

CryoClaw's design language = **TraeWork token system + ice-blue palette**. Light is the
default theme; dark mode switches at the token layer through two channels. This document
mirrors the current code; the single sources of truth are `shared/design-tokens.css` and
`chat-ui/ui/src/styles/primitives.css` — when in doubt, the code wins.

## 1. Principles

1. **Always use design tokens. Never hardcode hex** (e.g. `color: #fff`), never hardcode
   `border-radius` / spacing values, never `transition: all` (list explicit properties).
2. **Light is the default theme.** Do not write per-view dark styles — correct token usage
   gives both themes for free (`[data-theme=dark]` for the Chat UI, `prefers-color-scheme`
   as fallback for standalone pages like Setup).
3. **Reuse the `cc-*` primitives first** (see §4); do not invent new button/card/dialog styles.
4. **No `text-transform: uppercase`**: labels render as written — respect brand casing and
   CJK text. The only exception is the `cc-table` header, which follows the TraeWork
   component contract.
5. **Boolean settings always use the iOS-style Switch** (`<oc-toggle-switch>`, label left,
   switch right) — not radio buttons or checkboxes.
6. **Default action buttons align right**: dialog footers and settings button rows use
   `justify-content: flex-end` (built into `cc-dialog__foot`); only inline list-local
   actions may deviate.
7. **Metadata always uses mono small text**: model labels, tool names, token usage,
   timestamps, paths, status lines use `var(--font-meta)` + `var(--font-size-meta)` (11px),
   dimmed with `var(--text-muted)` / `var(--text-faint)`. Hierarchy comes from the grey
   scale + font weight, not stacked cards.

## 2. Token system (`shared/design-tokens.css`)

### 2.1 Static tokens (theme-independent)

- **Radius scale**: `--radius-2/4/6/8/10/12/16/20/24/32`; compat aliases
  `--radius-xs/sm/md/lg/xl` (= 4/8/12/16/20), `--radius-pill` (999px).
- **Spacer scale**: `--spacer-2/3/4/6/8/10/12/16/20/24/32/40/48/64`.
- **Icon sizes**: `--icon-size-12/14/16/20/24`.
- **Font stacks**: `--font-body` (SF Pro Text + PingFang SC fallback), `--font-display`,
  `--mono` (JetBrains Mono family), `--font-meta` = `--mono`; `--font-size-meta: 11px`,
  `--font-size-body: 14px`.
- **Type scale**: body `--text-2xs/xs/sm/base/lg` (10/11/12/14/18), headings
  `--heading-xs/sm/md/lg/xl/2xl/3xl` (13/16/20/22/24/28/32).
- **Motion**: `--ease-out/--ease-in-out/--ease-spring`,
  `--duration-fast/normal/slow` (0.12/0.2/0.35s), `--transition: 180ms ease`.

### 2.2 Palette

- **Brand ice-blue scale**: `--brand-50 … --brand-950`, primary **`--brand-500: #0EA5E9`**.
- **Cool grey scale** (slight blue tint): `--grey-50 … --grey-950`.
- Semantic colors: `--ok`, `--destructive`, `--warn`, `--info` (= brand), each with
  `-muted` / `-subtle` variants.

### 2.3 Theme variables (light default / dark override)

- Backgrounds: `--bg`, `--bg-secondary`, `--bg-elevated`, `--bg-hover`, `--bg-input`,
  `--bg-muted`.
- Text: `--text`, `--text-strong`, `--text-secondary`, `--text-muted`, `--text-faint`,
  `--text-on-accent`.
- Borders: `--border`, `--border-strong`, `--border-hover`, `--border-focus`.
- Accent: `--accent` (light = brand-500, dark brightens to brand-400), `--accent-hover`,
  `--accent-subtle`, `--accent-glow`.
- Overlay/glass: `--overlay(-heavy)`, `--glass-xs/sm/md/lg`, `--glass-border`.
- Shadows: `--shadow-sm/md/lg/xl`.
- Dark is defined twice with identical variable sets: `:root[data-theme=dark]` (Chat UI)
  and `@media (prefers-color-scheme: dark)` (standalone-page fallback).

### 2.4 Chat UI extension aliases (`styles/tokens-ext.css`)

Compat aliases — `--card`, `--popover`, `--panel`, `--ring`, `--focus-ring`,
`--danger(-muted/-subtle)`, `--accent-2`, `--primary`, `--secondary` — all map onto the
tokens above. New code should prefer the semantic variables in §2.3; the alias layer exists
for legacy compatibility, do not expand it.

## 3. Theme & color usage

- The accent is always ice-blue `--accent`; red/green/amber are semantic status colors only
  (error/ok/warn), never theme colors.
- Large white space + subtle tonal separation instead of hard dividers; hover feedback =
  slight background tint + stronger border.
- The old "signature red `#c0392b`" rule is retired (replaced by ice-blue in R2) — do not
  reference it.

## 4. Component primitives (`styles/primitives.css`, `cc-` prefix)

| Class | Purpose | Variants / notes |
|---|---|---|
| `cc-btn` | Button, height 28, radius-8, weight 500 | `--primary` / `--secondary` / `--ghost` / `--danger`; `--sm` (h 24); `--loading` (leading spinner); `--disabled` |
| `cc-input` / `cc-select` / `cc-textarea` | Form controls | min-height 32, focus = `--border-focus` + `--focus-ring` |
| `cc-card` | Card | radius-12, padding-20; `--interactive` (hover lift) |
| `cc-dialog` | Dialog | with `cc-dialog-overlay`; max-width 520; `__head/__title/__close/__body/__foot` (foot buttons right-aligned) |
| `cc-tag` | Tag, height 22 | `--brand` / `--success` / `--warn` / `--error` |
| `cc-menu` / `cc-menu-item` | Popup menu | item min-height 32 |
| `cc-alert` | Alert bar, 3px semantic left border | `--info` / `--success` / `--warn` / `--error` |
| `cc-skeleton` | Skeleton | gradient shine; animation off under `prefers-reduced-motion` |
| `cc-table` | Table | subdued small header, rows divided by `--border`, row hover tint |
| `cc-tabs` / `cc-tab` | Tabs | underline indicator, `--active` |
| `cc-chip` | Chip (selectable) | `--selected` = accent border + subtle bg |

The Switch is not in primitives: use the `<oc-toggle-switch>` component
(`components/toggle-switch.ts`, iOS style).

## 5. Style organization

- **The hub `chat-ui/ui/src/styles.css` only `@import`s; cascade order is load-bearing —
  never reorder casually**: design-tokens → tokens-ext → base → **primitives** → chat /
  components / panels / sidebar / skills / compose / workspace / cron / misc / panel /
  plan → (last) **settings → setup**.
- `styles/settings.css` (settings page) and `styles/setup.css` (setup wizard) were
  extracted in R3B from view-TS inline CSS (adoptedStyleSheets); those used to outrank
  document stylesheets, so they must stay **last** in the import list.
- View styles may override primitives (primitives sit after base and before view styles —
  intentional).
- Shadow-DOM local styles of Lit components under `components/` are a legitimate exception
  and stay out of the split files.
- New styles: first try composing tokens + cc-* primitives; if you must add CSS, put it in
  the matching split file; new colors/radii/spacing go into `design-tokens.css` first.
- Standalone pages (`setup/webbridge-enable-guide.html`, etc.) also `@import`
  shared/design-tokens.css.

## 6. Layout conventions

- Immersive top titlebar, height 44px; **top-floating layers keep `top ≥ 56px`** (plan
  panel / toast / error bar).
- Media queries cover ultra-narrow windows (≤768px).
- Grid overflow guard: `grid-template-columns: minmax(0,1fr)` + `min-width: 0` on children.

## 7. Tooltip

- **No CSS `::after` pseudo-element tooltips** (always clipped inside `overflow`
  containers). Use the global `position: fixed` `.fixed-tooltip` element plus the
  `data-tooltip="text"` attribute; `data-tooltip-pos="bottom"` flips direction.
- **Tooltips only on icon-only buttons**; buttons/menu items with text labels get none.
