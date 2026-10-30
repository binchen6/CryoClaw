# Layout and sizing

The board places cards on a fluid 12-unit grid; the card receives its real pixel box and must
reflow inside it. There is no fixed canvas: the same document is shown at every width, in a
fullscreen expansion, and after the user resizes it.

## Board grid

- 12 units per row, `20px` gap (compact mode `10px`).
- Card width = `(100% + gap) * w / 12 - gap`; `w` accepts fractions (`4.5`) after a manual resize.
- Height is pixels, `180–1000`; `order` is the reading order, `0–10000`.
- A card wider than 10.5 units takes the whole row; the rest flow around it.
- `free: true` means the user resized by hand: keep that width instead of reflowing it.

Approximate rendered widths on a 1200 px board:

| Units | 2 | 3 | 4 | 5 | 6 | 8 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Width | 190 | 295 | 400 | 505 | 610 | 820 | 1200 |

## Breakpoints inside a card

The iframe viewport is the card box. Use media queries (or `@container` on your own wrapper):

| Width | Layout |
| --- | --- |
| `< 420px` | Single column, 18px padding, hide decoration, keep controls ≥32px |
| `420–520px` | Single column, 20px padding, stack metric rows |
| `520–860px` | Two columns where useful; charts keep 16px side padding |
| `> 860px` | Full composition; side-by-side chart and detail |

Height matters as much as width: below `260px` hide secondary rows and keep the primary number
and one action; below `300px` reduce hero type and padding.

## Choosing a size

| Content | Suggested placement |
| --- | --- |
| Single metric or status | `3×240` – `4×300` |
| Notes, checklist, small list | `4×320` – `6×400` |
| Chart with a short table | `6×380` – `8×440` |
| Table or timeline with detail | `8×460` – `12×520` |
| Hero / guided panel | `12×280` – `12×340` |

A new card defaults to `6×300`. Pass `layout` only when creating the card or when the user asks
to change size. When updating, omit `layout` — the user's geometry is authoritative.

## Content flow

- `html`, `body` and one root wrapper stay in normal flow. The host allows `body` to scroll
  vertically when content is taller than the card; do not set `height: 100vh` or `overflow: hidden`
  on the root.
- Prefer one scroll area. Avoid a scrollable list inside an already scrolling document unless the
  inner list has a clear fixed height and its own affordance.
- The host forwards wheel deltas the card cannot use to the board, so a card that fits its box
  scrolls the board naturally. A card with tall content scrolls itself first.
- Use `clamp()` for hero type, `minmax(0, 1fr)` in grids, and `overflow-wrap: anywhere` on long
  Chinese/URL text.
- Do not rely on hover for essential actions; provide a visible control on touch layouts.

## Expanded view

- Expand keeps the same running document (inputs, timers, local state survive). Design the
  composition to benefit from extra space instead of stretching one column.
- The expanded surface has a `44px` chrome; keep the top `44px` free of controls.
- `Esc` and the close button collapse back to the same card with its scroll position restored.

## Verification sizes

Check at least the intended size plus one narrow and one short variant:

1. target placement (for example `6×340`),
2. `360×300` (narrow phone-like card),
3. `900×260` (wide but short),
4. expanded at the window size.

If the card is deliberately single-size, verify that size and keep the rest readable, not perfect.
