# Dashboard design system

Cards are product surfaces, not posters. They sit inside a board the user arranges, so each card
must be readable at 2–12 columns, at 180–1000 px height, and in a fullscreen expansion of the same
document.

## Character

Ice blue, ink and paper, with clear Chinese typography and quiet metadata.

- One headline, one visual idea, one primary action at most.
- Information density over decoration: no gradients on every surface, no glow, no stock imagery.
- Data provenance is part of the design: source and time are always visible, failures are stated.
- Motion is sparse, purposeful and reversible; never animate to hide latency.

## Tokens

Use these values directly in the card. The iframe does not inherit the app's CSS variables.

| Token | Value | Use |
| --- | --- | --- |
| `--ink` | `#0f1216` | Headlines, primary text |
| `--ink-soft` | `#2b3a45` | Dense body text |
| `--muted` | `#69727a` | Secondary copy |
| `--faint` | `#8a949c` | Metadata, captions |
| `--line` | `#e6edf2` | Hairlines, dividers |
| `--line-soft` | `#eef3f7` | Table rows, quiet separators |
| `--ice` | `#168aff` | Accent, progress, links |
| `--ice-deep` | `#0b63b0` | Accent text on light surfaces |
| `--ice-soft` | `#e8f3ff` | Accent wash, selected rows |
| `--mint` | `#12b981` | Success, positive trend |
| `--warn` | `#d97706` | Warning, stale data |
| `--danger` | `#dc2626` | Failure, destructive |
| `--paper` | `#ffffff` | Card background |
| `--paper-soft` | `#f8fbfd` | Nested panels, table headers |

Typography:

```css
font-family: MiSans, Inter, "Microsoft YaHei UI", "PingFang SC", "Segoe UI", system-ui, sans-serif;
font-variant-numeric: tabular-nums; /* every number */
```

| Role | Size / weight / tracking |
| --- | --- |
| Hero | `clamp(30px, 4.6vw, 46px)` / 800 / `-1.6px` |
| Card title | `22px` / 750 / `-.5px` |
| Section | `13px` / 700 / `.02em` |
| Body | `13px` / 400 / line-height `1.7` |
| Metadata | `10–11px` mono / 600 / `.12em` uppercase for labels |

Spacing scale: `4, 6, 8, 10, 12, 14, 16, 20, 24, 28`. Radii: `10px` controls, `12px` panels,
`16px` feature blocks, `20px` hero surfaces. Use `1px solid var(--line)` instead of shadows for
structure; one soft shadow is allowed for a floating element only.

## Composition patterns

Reserve the top `40–46px` of every normal card: the host shows the card title and actions there on
hover. Do not place headings or primary controls under that band, and keep the expanded layout's
`44px` chrome clear as well.

### Hero

Eyebrow, one large claim, one supporting paragraph, at most one CTA. Put decoration on one side
only and hide it below 760 px wide or 250 px tall.

### Metric row

Three to four metrics in a grid; each has a label, a large tabular number and a unit or delta.
Never show a metric without its window (today / 7 days / since 09:41).

### Chart + detail

SVG sparkline or bars on the left/top, a short table or list on the right/bottom. Always label
the axis window and the source. Use `--ice` for the series, `--line` for the grid, no more than
two series.

### List / table

Rows of `grid-template-columns: minmax(0,1fr) auto`; header row in mono uppercase. Right-align
numbers. Sticky headers are unnecessary in cards; keep tables short and let the card scroll.

### Controls

- Primary action: dark pill (`background: var(--ink); color: #fff`), one per card.
- Secondary: white with `1px solid var(--line)` border.
- Text action: `color: var(--ice-deep)`, no underline, arrow `↗` only when it opens something.
- Minimum hit area `32×32px`; focus ring `0 0 0 3px #168aff26`.

### States

Every card needs four states, even if the data is static:

1. **Loading** – skeleton rows or `正在读取…`; keep the layout height stable.
2. **Empty** – what the user can do next, not just "no data".
3. **Error** – plain-language cause plus a retry that reuses the same card.
4. **Stale** – keep the last value visible and label `已过期 · 09:12`.

## Motion

- Continuous work: `sdk.motion.frame(draw, { fps: 30 })`; stop when hidden (the host does this).
- One-shot transitions: `sdk.motion.animate(element, keyframes, { duration: 180–240 })`.
- Animate `transform` and `opacity` only; never animate layout properties per frame.
- Ambient loops must be quiet enough to read over; no flashing, no unbounded particle counts.
- Reduced motion: the SDK reports `sdk.motion.reduced`; draw one final frame and keep controls
  usable. Never remove functionality.

## Accessibility

- Real `<button>`, `<input>`, `<table>` semantics; `aria-label` on icon-only controls.
- Visible focus; keyboard reachable in DOM order; `Esc` collapses expansion (host handles it).
- Contrast: body text ≥ 4.5:1 on its background; never encode meaning with color alone.
- Numbers carry units; timestamps carry timezone or relative wording.
- Do not trap focus or auto-play audio. Audio starts only from an explicit user action.

## Anti-patterns

- Fake dashboards: invented percentages, invented "live" labels, unlabeled axes.
- Nested scroll areas (page + inner list + textarea) competing for the wheel.
- Fixed pixel layouts that break below 420 px or above 1000 px wide.
- Full-bleed background images behind text; heavy blur; ten accent colors.
- Copying another product's branding or mascots.
- Persisting UI state on every keystroke or animation frame.
