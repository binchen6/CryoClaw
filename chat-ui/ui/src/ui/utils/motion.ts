export const MOTION_MS = {
  feedback: 140,
  panel: 240,
  enter: 360,
  scene: 540,
} as const;

export type MotionPreference = "system" | "full" | "reduce";
let preference: MotionPreference = "system";
let systemQuery: MediaQueryList | null = null;
let listening = false;

function systemReduced(): boolean {
  return systemQuery?.matches ?? (typeof window !== "undefined" && typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

export function applyMotionPreference(): void {
  const root = typeof document !== "undefined" ? document.documentElement : null;
  if (!root) return;
  const reduced = preference === "reduce" || (preference === "system" && systemReduced());
  root.dataset.motion = reduced ? "reduce" : "full";
}

export function configureMotionPreference(next: MotionPreference): void {
  preference = next;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    systemQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!listening) {
      listening = true;
      systemQuery.addEventListener("change", applyMotionPreference);
    }
  }
  applyMotionPreference();
}

export function prefersReducedMotion(): boolean {
  const rootPreference = typeof document !== "undefined" ? document.documentElement?.dataset?.motion : undefined;
  if (rootPreference) return rootPreference === "reduce";
  return preference === "reduce" || (preference === "system" && systemReduced());
}
