import test from "node:test";
import assert from "node:assert/strict";
import { placePopover, rectsOverlap } from "./popover-placement.ts";
import type { PopoverAlign, PopoverRect } from "./popover-placement.ts";

const VIEWPORT = { width: 1000, height: 800 };

const rect = (left: number, top: number, width: number, height: number): PopoverRect => ({
  left,
  top,
  width,
  height,
});

test("places the panel directly below the anchor with no overflow", () => {
  const placement = placePopover({
    anchor: rect(100, 100, 80, 32),
    panel: { width: 200, height: 150 },
    viewport: VIEWPORT,
  });
  assert.deepEqual(placement, {
    left: 100,
    top: 140, // 100 + 32 + 8
    side: "bottom",
    align: "start",
    covered: false,
    overflowX: 0,
    overflowY: 0,
    shifted: 0,
  });
});

test("flips to the top when the viewport has no room below", () => {
  const placement = placePopover({
    anchor: rect(100, 600, 80, 32),
    panel: { width: 200, height: 150 },
    viewport: VIEWPORT,
  });
  assert.equal(placement.side, "top");
  assert.equal(placement.top, 442); // 600 - 8 - 150
  assert.equal(placement.left, 100);
  assert.equal(placement.covered, false);
  // Overflow is reported from the chosen candidate, not from the rejected bottom side.
  assert.equal(placement.overflowY, 0);
});

test("clamps horizontally when the anchor sits near the right edge", () => {
  const placement = placePopover({
    anchor: rect(950, 100, 40, 30),
    panel: { width: 200, height: 100 },
    viewport: VIEWPORT,
  });
  assert.equal(placement.side, "bottom");
  assert.equal(placement.left, 788); // max(12, 1000 - 12 - 200)
  assert.equal(placement.overflowX, 162); // 950 + 200 - (1000 - 12)
  assert.equal(placement.top, 138);
});

test("align end and center follow the anchor edges for vertical sides", () => {
  const anchor = rect(400, 100, 80, 32);
  const panel = { width: 200, height: 150 };
  const place = (align: PopoverAlign) =>
    placePopover({ anchor, panel, viewport: VIEWPORT, candidates: [{ side: "bottom", align }] });

  assert.equal(place("end").left, 280); // 400 + 80 - 200
  assert.equal(place("center").left, 340); // 400 + 40 - 100
  assert.equal(place("start").left, 400);

  // Center offsets may land on half pixels; they are rounded to 2 decimals.
  const oddWidth = placePopover({
    anchor: rect(400, 100, 81, 32),
    panel,
    viewport: VIEWPORT,
    candidates: [{ side: "bottom", align: "center" }],
  });
  assert.equal(oddWidth.left, 340.5);
});

test("an omitted candidate align defaults to start", () => {
  const placement = placePopover({
    anchor: rect(400, 100, 80, 32),
    panel: { width: 200, height: 150 },
    viewport: VIEWPORT,
    candidates: [{ side: "bottom" }],
  });
  assert.equal(placement.align, "start");
  assert.equal(placement.left, 400);
});

test("custom candidate order wins when every candidate fits", () => {
  const placement = placePopover({
    anchor: rect(300, 300, 80, 32),
    panel: { width: 200, height: 150 },
    viewport: VIEWPORT,
    candidates: [{ side: "right" }, { side: "bottom" }],
  });
  assert.equal(placement.side, "right");
  assert.equal(placement.left, 388); // 300 + 80 + 8
  assert.equal(placement.top, 300);
});

test("slides down to clear an avoid rect directly below the anchor", () => {
  const placement = placePopover({
    anchor: rect(100, 100, 80, 32),
    panel: { width: 200, height: 120 },
    viewport: VIEWPORT,
    avoid: [rect(100, 150, 200, 40)],
  });
  assert.equal(placement.side, "bottom");
  assert.equal(placement.top, 192); // avoid.bottom + 2 = 150 + 40 + 2
  assert.equal(placement.shifted, 52); // 192 - natural top 140
  assert.equal(placement.covered, false);
});

test("slideToAvoid false keeps the clamped rect and reports the cover", () => {
  const placement = placePopover({
    anchor: rect(100, 100, 80, 32),
    panel: { width: 200, height: 120 },
    viewport: VIEWPORT,
    candidates: [{ side: "bottom", align: "start" }],
    avoid: [rect(100, 150, 200, 40)],
    slideToAvoid: false,
  });
  assert.equal(placement.top, 140);
  assert.equal(placement.shifted, 0);
  assert.equal(placement.covered, true);
});

test("slides up to clear an avoid rect for top placements", () => {
  const placement = placePopover({
    anchor: rect(300, 300, 80, 32),
    panel: { width: 200, height: 120 },
    viewport: VIEWPORT,
    candidates: [{ side: "top", align: "start" }],
    avoid: [rect(300, 200, 200, 40)],
  });
  assert.equal(placement.side, "top");
  assert.equal(placement.top, 78); // 200 - 2 - 120
  assert.equal(placement.shifted, 94); // natural top 172 - 78
  assert.equal(placement.covered, false);
});

test("right and left placements slide horizontally to clear avoid rects", () => {
  const anchor = rect(300, 300, 60, 40);
  const panel = { width: 180, height: 120 };

  const right = placePopover({
    anchor,
    panel,
    viewport: VIEWPORT,
    candidates: [{ side: "right", align: "start" }],
    avoid: [rect(400, 300, 60, 120)],
  });
  assert.deepEqual(
    { left: right.left, top: right.top, shifted: right.shifted, covered: right.covered },
    { left: 462, top: 300, shifted: 94, covered: false }, // 400 + 60 + 2
  );

  const left = placePopover({
    anchor,
    panel,
    viewport: VIEWPORT,
    candidates: [{ side: "left", align: "start" }],
    avoid: [rect(200, 300, 40, 120)],
  });
  assert.deepEqual(
    { left: left.left, top: left.top, shifted: left.shifted, covered: left.covered },
    { left: 18, top: 300, shifted: 94, covered: false }, // 200 - 2 - 180
  );
});

test("keeps the covered flag when sliding would leave the viewport", () => {
  const placement = placePopover({
    anchor: rect(300, 600, 80, 32),
    panel: { width: 200, height: 120 },
    viewport: VIEWPORT,
    candidates: [{ side: "bottom", align: "start" }],
    avoid: [rect(300, 650, 200, 60)],
  });
  assert.equal(placement.top, 640);
  assert.equal(placement.covered, true);
  assert.equal(placement.shifted, 0);
});

test("reports covered and the smallest overflow when every candidate is blocked", () => {
  const placement = placePopover({
    anchor: rect(100, 100, 80, 32),
    panel: { width: 200, height: 150 },
    viewport: VIEWPORT,
    avoid: [rect(0, 0, 1000, 800)],
  });
  assert.equal(placement.side, "bottom");
  assert.equal(placement.covered, true);
  assert.equal(placement.shifted, 0);
  // The bottom side overflows neither axis, so it wins among the covered candidates.
  assert.equal(placement.overflowX, 0);
  assert.equal(placement.overflowY, 0);
});

test("oversized panels clamp to the padding edge and report overflow", () => {
  const placement = placePopover({
    anchor: rect(100, 100, 80, 32),
    panel: { width: 1200, height: 100 },
    viewport: { width: 800, height: 600 },
  });
  assert.equal(placement.left, 12); // padding, since the panel cannot fit
  assert.equal(placement.overflowX, 512); // 100 + 1200 - (800 - 12)
  assert.equal(placement.side, "bottom");
});

test("left and right placements follow vertical align start/center/end", () => {
  const anchor = rect(300, 200, 60, 40);
  const panel = { width: 180, height: 120 };
  const place = (side: "left" | "right", align: PopoverAlign) =>
    placePopover({ anchor, panel, viewport: VIEWPORT, candidates: [{ side, align }] });

  assert.deepEqual(
    { left: place("right", "start").left, top: place("right", "start").top },
    { left: 368, top: 200 }, // 300 + 60 + 8
  );
  assert.equal(place("right", "center").top, 160); // 200 + 20 - 60
  assert.equal(place("right", "end").top, 120); // 200 + 40 - 120

  assert.deepEqual(
    { left: place("left", "start").left, top: place("left", "start").top },
    { left: 112, top: 200 }, // 300 - 8 - 180
  );
  assert.equal(place("left", "center").top, 160);
  assert.equal(place("left", "end").top, 120);
});

test("a non-overlapping avoid rect leaves the natural placement untouched", () => {
  const placement = placePopover({
    anchor: rect(100, 100, 80, 32),
    panel: { width: 200, height: 120 },
    viewport: VIEWPORT,
    avoid: [rect(600, 600, 100, 100)],
  });
  assert.deepEqual(
    { left: placement.left, top: placement.top, covered: placement.covered, shifted: placement.shifted },
    { left: 100, top: 140, covered: false, shifted: 0 },
  );
});

test("default gap is 8 and default padding is 12, both overridable", () => {
  const anchor = rect(2, 100, 80, 32); // 2px from the left edge
  const panel = { width: 200, height: 150 };

  const below = placePopover({ anchor, panel, viewport: VIEWPORT });
  assert.equal(below.top, 140); // 100 + 32 + 8
  assert.equal(below.left, 12); // clamped to default padding
  assert.equal(below.overflowX, 10); // 12 - 2

  const custom = placePopover({ anchor, panel, viewport: VIEWPORT, gap: 4, padding: 20 });
  assert.equal(custom.top, 136); // 100 + 32 + 4
  assert.equal(custom.left, 20);
  assert.equal(custom.overflowX, 18); // 20 - 2
});

test("rectsOverlap ignores touching edges until a margin grows the rects", () => {
  const a = rect(0, 0, 100, 100);
  assert.equal(rectsOverlap(a, rect(100, 0, 100, 100)), false); // shared vertical edge
  assert.equal(rectsOverlap(a, rect(100, 0, 100, 100), 2), true);
  assert.equal(rectsOverlap(a, rect(0, 100, 10, 10)), false); // shared horizontal edge
  assert.equal(rectsOverlap(a, rect(0, 100, 10, 10), 2), true);
  assert.equal(rectsOverlap(a, rect(50, 50, 100, 100)), true); // partial overlap
  assert.equal(rectsOverlap(a, rect(200, 200, 10, 10)), false); // disjoint
});
