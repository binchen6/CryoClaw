import "./styles.css";
import { t, getLocale } from "./ui/i18n";
import { installLayoutDiagnosticsHook } from "./ui/layout-diagnostics.ts";
import { placePopover, type PopoverCandidate } from "./ui/utils/popover-placement.ts";
import "./ui/app.ts";

// 渲染进程启动时同步页面标题，避免文档标题与原生窗口标题不一致。
document.title = t("app.windowTitle");

// 同步文档语言（WCAG 3.1.1 Language of Page）：index.html 静态写死 en，
// 中文用户（或 ?lang=zh）下若不更新，读屏发音与 CJK 字体选择都会被误导（R67）。
document.documentElement.lang = getLocale() === "zh" ? "zh-CN" : "en";

// Available to CDP smoke tests and local debugging; reports contain layout metadata only.
installLayoutDiagnosticsHook();

// 全局 fixed tooltip（不受 overflow 裁切，与 Settings 同一方案）。
// 定位走 placePopover：视口内自适应翻转 + 夹取，`data-tooltip-pos` 的四个方向都生效
// （right/left 供图标轨等窄边控件使用）；hover 与键盘聚焦共用同一条显示路径。
(function initFixedTooltip() {
  const tip = document.createElement("div");
  tip.className = "fixed-tooltip";
  document.body.appendChild(tip);
  let current: HTMLElement | null = null;

  const hide = () => {
    tip.style.opacity = "0";
    current = null;
  };

  const place = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const pos = anchor.getAttribute("data-tooltip-pos");
    // 首选方向来自 data-tooltip-pos，其余方向按「最靠近的对侧」兜底，避免贴边时被裁。
    const preferred: PopoverCandidate =
      pos === "bottom" ? { side: "bottom" as const, align: "center" as const }
        : pos === "right" ? { side: "right" as const, align: "center" as const }
          : pos === "left" ? { side: "left" as const, align: "center" as const }
            : { side: "top" as const, align: "center" as const };
    const candidates: PopoverCandidate[] = [
      preferred,
      { side: "bottom", align: "center" },
      { side: "top", align: "center" },
      { side: "right", align: "center" },
      { side: "left", align: "center" },
    ];
    // 先落到 0,0 量真实宽高：文案与 --wide 类都会改变尺寸，量不到就会算错落边。
    tip.style.left = "0px";
    tip.style.top = "0px";
    tip.style.transform = "none";
    const panel = { width: tip.offsetWidth, height: tip.offsetHeight };
    const placement = placePopover({ anchor: rect, panel, viewport, gap: 6, padding: 8, candidates, avoid: [rect] });
    tip.style.left = `${placement.left}px`;
    tip.style.top = `${placement.top}px`;
    tip.dataset.side = placement.side;
  };

  const show = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest<HTMLElement>("[data-tooltip]");
    if (!anchor || anchor.hasAttribute("disabled")) {
      hide();
      return;
    }
    const text = anchor.getAttribute("data-tooltip");
    if (!text) {
      hide();
      return;
    }
    current = anchor;
    tip.textContent = text;
    tip.classList.toggle("fixed-tooltip--wide", anchor.hasAttribute("data-tooltip-wide"));
    tip.style.opacity = "1";
    place(anchor);
  };

  document.addEventListener("mouseover", (e) => show(e.target));
  // 键盘用户同样要能看到说明：focusin 复用同一条定位路径。
  document.addEventListener("focusin", (e) => show(e.target));
  document.addEventListener("mouseout", (e) => {
    if ((e.target as HTMLElement | null)?.closest?.("[data-tooltip]")) hide();
  });
  document.addEventListener("focusout", (e) => {
    if ((e.target as HTMLElement | null)?.closest?.("[data-tooltip]")) hide();
  });
  // 浮层里的控件滚动/窗口尺寸变化时，悬浮说明会停在旧位置。
  const reposition = () => { if (current?.isConnected) place(current); else if (current) hide(); };
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
})();
