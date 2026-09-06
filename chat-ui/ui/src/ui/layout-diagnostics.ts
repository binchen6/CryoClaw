export type LayoutDiagnosticCode =
  | "horizontal-overflow"
  | "viewport-overflow"
  | "interactive-obscured";

export type LayoutDiagnosticIssue = {
  code: LayoutDiagnosticCode;
  target: string;
  detail: string;
};

export type LayoutDiagnosticReport = {
  viewport: { width: number; height: number };
  issues: LayoutDiagnosticIssue[];
  checked: number;
  generatedAt: number;
};

export type LayoutRectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export function layoutTargetLabel(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const classes = typeof element.className === "string"
    ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2)
    : [];
  return classes.length > 0 ? tag + "." + classes.join(".") : tag;
}

export function diagnoseLayoutRect(
  rect: LayoutRectLike,
  viewport: { width: number; height: number },
): LayoutDiagnosticIssue[] {
  if (rect.left < -1 || rect.right > viewport.width + 1 || rect.top < -1 || rect.bottom > viewport.height + 1) {
    return [{
      code: "viewport-overflow",
      target: "rect",
      detail: "rect " + Math.round(rect.left) + "," + Math.round(rect.top) + "-" + Math.round(rect.right) + "," + Math.round(rect.bottom) + " exceeds " + viewport.width + "x" + viewport.height,
    }];
  }
  return [];
}

const DEFAULT_LAYOUT_SELECTORS = [
  "main", "[role=main]", "[role=dialog]", ".cryoclaw-shell", ".cryoclaw-titlebar",
  ".cc-rail", ".chat-thread", ".chat-compose", ".oc-modal-dialog", ".oc-settings",
  "[data-layout-check]",
];

// 窄于该宽度的容器视为"折叠面板"（如手机宽度下被侧栏挤压的主内容区）：
// 其子内容必然放不下，但不产生页面级滚动（viewport 检查兜底），不作为布局缺陷上报。
const COLLAPSED_PANE_MIN_CLIENT_WIDTH = 120;

/**
 * 纯函数：判定一个容器是否构成应上报的横向溢出。
 * - 容器自身允许横向滚动（overflow-x: auto/scroll）→ 不上报（滚动即预期行为）。
 * - 折叠面板（clientWidth 低于阈值）→ 不上报，页面级溢出由 viewport 检查兜底。
 */
export function diagnoseHorizontalOverflow(
  scrollWidth: number,
  clientWidth: number,
  overflowX: string,
  collapsedPaneMinWidth = COLLAPSED_PANE_MIN_CLIENT_WIDTH,
): LayoutDiagnosticIssue[] {
  if (clientWidth < collapsedPaneMinWidth) return [];
  if (scrollWidth <= clientWidth + 1) return [];
  if (overflowX === "auto" || overflowX === "scroll") return [];
  return [{
    code: "horizontal-overflow",
    target: "rect",
    detail: "scrollWidth " + scrollWidth + " > clientWidth " + clientWidth,
  }];
}

function isInteractive(element: Element): boolean {
  return element.matches("button, a, input, select, textarea, [role=button], [tabindex]");
}

function isVisible(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

/** A secret-free renderer report for CDP layout smoke tests. */
export function collectLayoutDiagnostics(
  doc?: Document,
  viewport?: { width: number; height: number },
): LayoutDiagnosticReport {
  const resolvedDoc = doc ?? (typeof document !== "undefined" ? document : null);
  const resolvedViewport = viewport ?? {
    width: typeof window !== "undefined" ? window.innerWidth : 0,
    height: typeof window !== "undefined" ? window.innerHeight : 0,
  };
  if (!resolvedDoc) return { viewport: resolvedViewport, issues: [], checked: 0, generatedAt: Date.now() };

  const elements = [...resolvedDoc.querySelectorAll(DEFAULT_LAYOUT_SELECTORS.join(","))].filter(isVisible);
  const issues: LayoutDiagnosticIssue[] = [];
  const seen = new Set<Element>();
  for (const element of elements) {
    if (seen.has(element)) continue;
    seen.add(element);
    const target = layoutTargetLabel(element);
    const rect = element.getBoundingClientRect();
    for (const issue of diagnoseLayoutRect(rect, resolvedViewport)) issues.push({ ...issue, target });

    const style = getComputedStyle(element);
    for (const issue of diagnoseHorizontalOverflow(element.scrollWidth, element.clientWidth, style.overflowX)) {
      issues.push({ ...issue, target });
    }

    if (isInteractive(element) && resolvedDoc.elementFromPoint) {
      const x = Math.max(0, Math.min(resolvedViewport.width - 1, rect.left + Math.min(rect.width / 2, 12)));
      const y = Math.max(0, Math.min(resolvedViewport.height - 1, rect.top + Math.min(rect.height / 2, 12)));
      const hit = resolvedDoc.elementFromPoint(x, y);
      if (hit && hit !== element && !element.contains(hit)) {
        issues.push({ code: "interactive-obscured", target, detail: "center hit " + layoutTargetLabel(hit) });
      }
    }
  }
  return { viewport: resolvedViewport, issues, checked: seen.size, generatedAt: Date.now() };
}

export function installLayoutDiagnosticsHook(): void {
  if (typeof window === "undefined") return;
  const target = window as typeof window & { __ocLayoutDiagnostics?: { run: () => LayoutDiagnosticReport } };
  target.__ocLayoutDiagnostics = { run: () => collectLayoutDiagnostics() };
}
