/**
 * Shared popover placement: flip through candidate sides, clamp into the
 * viewport, then slide along the main axis so the panel does not cover a
 * primary control (trigger button, send action, …).
 *
 * Pure TypeScript, no DOM access: callers pass measured rects, so real layout,
 * unit tests and keyboard navigation share one placement rule. Render code only
 * has to apply the returned left/top.
 *
 * All emitted numbers are rounded to 2 decimals: measurements come from
 * getBoundingClientRect and would otherwise leak float noise into inline styles
 * and assertions.
 */

export type PopoverSide = "top" | "bottom" | "left" | "right";
export type PopoverAlign = "start" | "center" | "end";

export interface PopoverRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface PopoverViewport {
  width: number;
  height: number;
}

export interface PopoverCandidate {
  side: PopoverSide;
  align?: PopoverAlign;
}

export interface PlacePopoverOptions {
  anchor: PopoverRect;
  panel: PopoverSize;
  viewport: PopoverViewport;
  /** distance between anchor edge and panel, default 8 */
  gap?: number;
  /** minimum distance to viewport edges, default 12 */
  padding?: number;
  /** ordered preference list, default [{side:"bottom",align:"start"},{side:"top",align:"start"}] */
  candidates?: PopoverCandidate[];
  /** rects the panel should try not to cover (trigger and primary controls) */
  avoid?: PopoverRect[];
  /** slide along the main axis to clear an avoid rect when possible, default true */
  slideToAvoid?: boolean;
}

export interface PopoverPlacement {
  left: number;
  top: number;
  side: PopoverSide;
  align: PopoverAlign;
  /** chosen rect still overlaps an avoid rect */
  covered: boolean;
  /** px the natural rect would exceed the allowed viewport box, before clamping (>=0) */
  overflowX: number;
  overflowY: number;
  /** extra slide px applied along the main axis to clear avoid rects (0 when none, always >=0) */
  shifted: number;
}

const DEFAULT_GAP = 8;
const DEFAULT_PADDING = 12;
/** Breathing room used when checking against avoid rects, so a slide clears them visually too. */
const AVOID_MARGIN = 2;
/** Non-covered placements always beat covered ones; overflow (×1000) breaks ties first. */
const COVERED_PENALTY = 1e6;
const OVERFLOW_WEIGHT = 1000;
const DEFAULT_CANDIDATES: readonly PopoverCandidate[] = [
  { side: "bottom", align: "start" },
  { side: "top", align: "start" },
];

interface LayoutContext {
  anchor: PopoverRect;
  panel: PopoverSize;
  viewport: PopoverViewport;
  gap: number;
  padding: number;
  avoid: readonly PopoverRect[];
  slideToAvoid: boolean;
}

interface EvaluatedCandidate {
  side: PopoverSide;
  align: PopoverAlign;
  left: number;
  top: number;
  covered: boolean;
  shifted: number;
  overflowX: number;
  overflowY: number;
}

interface Slide {
  left: number;
  top: number;
  shifted: number;
}

/** Round to 2 decimals and normalise -0, so strict comparisons behave. */
function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/** Round up / down to 2 decimals: a slid rect must still clear its blocker after rounding. */
function ceil2(value: number): number {
  return round2(Math.ceil(value * 100) / 100);
}

function floor2(value: number): number {
  return round2(Math.floor(value * 100) / 100);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function panelRect(left: number, top: number, panel: PopoverSize): PopoverRect {
  return { left, top, width: panel.width, height: panel.height };
}

/** offset of the panel from the anchor for one cross-axis alignment rule. */
function crossAxisOffset(align: PopoverAlign, origin: number, anchorSize: number, panelSize: number): number {
  if (align === "start") return origin;
  if (align === "center") return origin + anchorSize / 2 - panelSize / 2;
  return origin + anchorSize - panelSize;
}

/** Natural (pre-clamp) position of a candidate. */
function naturalPosition(
  side: PopoverSide,
  align: PopoverAlign,
  anchor: PopoverRect,
  panel: PopoverSize,
  gap: number,
): { left: number; top: number } {
  if (side === "top" || side === "bottom") {
    const top = side === "bottom"
      ? anchor.top + anchor.height + gap
      : anchor.top - gap - panel.height;
    return {
      left: round2(crossAxisOffset(align, anchor.left, anchor.width, panel.width)),
      top: round2(top),
    };
  }
  const left = side === "right"
    ? anchor.left + anchor.width + gap
    : anchor.left - gap - panel.width;
  return {
    left: round2(left),
    top: round2(crossAxisOffset(align, anchor.top, anchor.height, panel.height)),
  };
}

/** How far the natural rect sticks out of the allowed viewport box on one axis. */
function overflowAmount(natural: number, size: number, viewportSize: number, padding: number): number {
  const before = Math.max(0, padding - natural);
  const after = Math.max(0, natural + size - (viewportSize - padding));
  return round2(before + after);
}

function overlapsAny(left: number, top: number, panel: PopoverSize, avoid: readonly PopoverRect[]): boolean {
  const rect = panelRect(left, top, panel);
  return avoid.some(other => rectsOverlap(rect, other, AVOID_MARGIN));
}

/**
 * Move one coordinate just past the blocking rects, or stay put when the move
 * would push the panel outside the viewport box.
 */
function slideAlongMainAxis(
  side: PopoverSide,
  left: number,
  top: number,
  panel: PopoverSize,
  viewport: PopoverViewport,
  padding: number,
  blockers: readonly PopoverRect[],
): Slide | null {
  if (blockers.length === 0) return null;

  if (side === "bottom" || side === "top") {
    // bottom placements slide down, top placements slide up; both move only vertically.
    const targets = blockers.map(blocker =>
      side === "bottom"
        ? blocker.top + blocker.height + AVOID_MARGIN
        : blocker.top - AVOID_MARGIN - panel.height,
    );
    const nextTop = side === "bottom" ? ceil2(Math.max(...targets)) : floor2(Math.min(...targets));
    if (nextTop === top || nextTop < padding || nextTop + panel.height > viewport.height - padding) {
      return null;
    }
    return { left, top: nextTop, shifted: round2(Math.abs(nextTop - top)) };
  }

  const targets = blockers.map(blocker =>
    side === "right"
      ? blocker.left + blocker.width + AVOID_MARGIN
      : blocker.left - AVOID_MARGIN - panel.width,
  );
  const nextLeft = side === "right" ? ceil2(Math.max(...targets)) : floor2(Math.min(...targets));
  if (nextLeft === left || nextLeft < padding || nextLeft + panel.width > viewport.width - padding) {
    return null;
  }
  return { left: nextLeft, top, shifted: round2(Math.abs(nextLeft - left)) };
}

function evaluateCandidate(candidate: PopoverCandidate, context: LayoutContext): EvaluatedCandidate {
  const { anchor, panel, viewport, gap, padding, avoid, slideToAvoid } = context;
  const align = candidate.align ?? "start";
  const natural = naturalPosition(candidate.side, align, anchor, panel, gap);

  // The clamp range collapses to `padding` when the panel is larger than the box.
  const maxLeft = Math.max(padding, viewport.width - padding - panel.width);
  const maxTop = Math.max(padding, viewport.height - padding - panel.height);
  let left = clamp(natural.left, padding, maxLeft);
  let top = clamp(natural.top, padding, maxTop);

  // Overflow is reported from the natural rect: clamping is what hides it, so it
  // has to be measured before the clamp for candidate scoring to see it.
  const overflowX = overflowAmount(natural.left, panel.width, viewport.width, padding);
  const overflowY = overflowAmount(natural.top, panel.height, viewport.height, padding);

  let covered = overlapsAny(left, top, panel, avoid);
  let shifted = 0;

  if (covered && slideToAvoid) {
    const rect = panelRect(left, top, panel);
    const blockers = avoid.filter(other => rectsOverlap(rect, other, AVOID_MARGIN));
    const slide = slideAlongMainAxis(candidate.side, left, top, panel, viewport, padding, blockers);
    if (slide) {
      left = slide.left;
      top = slide.top;
      shifted = slide.shifted;
      covered = overlapsAny(left, top, panel, avoid);
    }
  }

  return { side: candidate.side, align, left, top, covered, shifted, overflowX, overflowY };
}

function candidateScore(candidate: EvaluatedCandidate, index: number): number {
  return (
    (candidate.covered ? COVERED_PENALTY : 0) +
    candidate.overflowX * OVERFLOW_WEIGHT +
    candidate.overflowY * OVERFLOW_WEIGHT +
    index
  );
}

/** Place a popover panel relative to an anchor rect. Pure: no DOM reads or writes. */
export function placePopover(options: PlacePopoverOptions): PopoverPlacement {
  const context: LayoutContext = {
    anchor: options.anchor,
    panel: options.panel,
    viewport: options.viewport,
    gap: options.gap ?? DEFAULT_GAP,
    padding: options.padding ?? DEFAULT_PADDING,
    avoid: options.avoid ?? [],
    slideToAvoid: options.slideToAvoid ?? true,
  };
  const candidates: readonly PopoverCandidate[] =
    options.candidates && options.candidates.length > 0 ? options.candidates : DEFAULT_CANDIDATES;

  let best = evaluateCandidate(candidates[0], context);
  let bestScore = candidateScore(best, 0);
  for (let index = 1; index < candidates.length; index += 1) {
    const evaluated = evaluateCandidate(candidates[index], context);
    const score = candidateScore(evaluated, index);
    // Strict `<` keeps the earlier candidate on a tie, i.e. caller order wins.
    if (score < bestScore) {
      best = evaluated;
      bestScore = score;
    }
  }

  return {
    left: round2(best.left),
    top: round2(best.top),
    side: best.side,
    align: best.align,
    covered: best.covered,
    overflowX: best.overflowX,
    overflowY: best.overflowY,
    shifted: best.shifted,
  };
}

/** True when the two rects intersect; `margin` grows both rects by that many px. */
export function rectsOverlap(a: PopoverRect, b: PopoverRect, margin = 0): boolean {
  return (
    a.left < b.left + b.width + margin &&
    a.left + a.width + margin > b.left &&
    a.top < b.top + b.height + margin &&
    a.top + a.height + margin > b.top
  );
}
