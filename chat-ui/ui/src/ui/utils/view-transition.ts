export function isViewTransitionActive(): boolean {
  try { return typeof document!=="undefined" && Boolean(document.documentElement?.matches(":active-view-transition")); }
  catch { return false; }
}
/** CSS owns route entrance motion; document snapshots make the new controls unclickable. */
export function transitionView(change: () => void): void {
  const doc=document as Document & {activeViewTransition?:{skipTransition():void}|null};
  try { doc.activeViewTransition?.skipTransition(); } catch { /* A finished component transition needs no cleanup. */ }
  change();
}
