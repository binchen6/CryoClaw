import { html, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";

// ============================================================================
// CryoIcons — CryoClaw 自绘图标体系（2026.9 R2 设计规范）
//
// 规范：
//   - 24x24 viewBox，2px 描边，round linecap/linejoin，stroke="currentColor"
//   - 纯几何构造（直线 / 圆 / 圆弧 / 圆角矩形），克制、工程感，与沉稳蓝品牌一致
//   - 静态字符串，无用户输入，无 XSS 面（配合 grouped-render.test.ts 审计说明）
// 全部图标为本项目原创绘制，无任何第三方图标库依赖。
// ============================================================================

function renderIcon(inner: string): TemplateResult {
  return html`${unsafeSVG(
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`,
  )}`;
}

export const icons = {
  // ── 导航 / 消息 ──

  // 消息引用（双引号）
  quote: renderIcon(
    '<path d="M9.5 6.5c-2.5.6-4 2.3-4 5.1V16a1.5 1.5 0 0 0 1.5 1.5h2.5A1.5 1.5 0 0 0 11 16v-3a1.5 1.5 0 0 0-1.5-1.5H7.2c.2-1.6 1-2.6 2.3-3z"/>' +
      '<path d="M19.5 6.5c-2.5.6-4 2.3-4 5.1V16a1.5 1.5 0 0 0 1.5 1.5h2.5A1.5 1.5 0 0 0 21 16v-3a1.5 1.5 0 0 0-1.5-1.5h-2.3c.2-1.6 1-2.6 2.3-3z"/>',
  ),
  // 重发（逆时针回旋箭头）
  rotateCcw: renderIcon(
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3L3.5 8.5"/><path d="M3.5 3.5v5h5"/>',
  ),
  fileText: renderIcon(
    '<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M13.5 3v5.5H19"/><path d="M9 13h6"/><path d="M9 16.5h6"/>',
  ),
  zap: renderIcon('<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>'),
  monitor: renderIcon(
    '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8.5 20.5h7"/><path d="M12 16.5v4"/>',
  ),
  // 齿轮：中心圆 + 8 辐齿
  settings: renderIcon(
    '<circle cx="12" cy="12" r="3.2"/>' +
      '<path d="M12 2.8v2.8"/><path d="M12 18.4v2.8"/><path d="M2.8 12h2.8"/><path d="M18.4 12h2.8"/>' +
      '<path d="m5.5 5.5 2 2"/><path d="m16.5 16.5 2 2"/><path d="m18.5 5.5-2 2"/><path d="m7.5 16.5-2 2"/>',
  ),

  // ── 通用 UI ──

  x: renderIcon('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
  check: renderIcon('<path d="M4 12.8 9.5 18.3 20 6"/>'),
  warning: renderIcon(
    '<path d="M12 3.5 21.8 20H2.2z"/><path d="M12 9.5V14"/><path d="M12 17h.01"/>',
  ),
  plus: renderIcon('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  arrowDown: renderIcon('<path d="M12 4v15.5"/><path d="m6 13.5 6 6 6-6"/>'),
  arrowLeft: renderIcon('<path d="M20 12H4.5"/><path d="m10.5 6-6 6 6 6"/>'),
  arrowUp: renderIcon('<path d="M12 20V4.5"/><path d="m6 10.5 6-6 6 6"/>'),
  copy: renderIcon(
    '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4.5A2.5 2.5 0 0 1 2 12.5v-8A2.5 2.5 0 0 1 4.5 2h8A2.5 2.5 0 0 1 15 4.5V5"/>',
  ),
  refreshCw: renderIcon(
    '<path d="M20.5 12a8.5 8.5 0 1 1-2.8-6.3l2.8 2.8"/><path d="M20.5 3.5v5h-5"/>',
  ),
  search: renderIcon('<circle cx="11" cy="11" r="6.5"/><path d="m16.2 16.2 4.3 4.3"/>'),
  // 大脑：左右半球 + 中央裂隙
  brain: renderIcon(
    '<path d="M12 5a2.5 2.5 0 0 0-2.5-2.5A2.5 2.5 0 0 0 7 5a2.5 2.5 0 0 0-2 4 2.5 2.5 0 0 0 0 4A2.5 2.5 0 0 0 7 17a2.5 2.5 0 0 0 5 0z"/>' +
      '<path d="M12 5a2.5 2.5 0 0 1 2.5-2.5A2.5 2.5 0 0 1 17 5a2.5 2.5 0 0 1 2 4 2.5 2.5 0 0 1 0 4 2.5 2.5 0 0 1-2 4 2.5 2.5 0 0 1-5 0z"/>',
  ),
  // 加载（8 辐条）
  loader: renderIcon(
    '<path d="M12 3v3.2"/><path d="M12 17.8V21"/><path d="M3 12h3.2"/><path d="M17.8 12H21"/>' +
      '<path d="m5.6 5.6 2.3 2.3"/><path d="m16.1 16.1 2.3 2.3"/><path d="m18.4 5.6-2.3 2.3"/><path d="m7.9 16.1-2.3 2.3"/>',
  ),
  clock: renderIcon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.4 2"/>'),
  stop: renderIcon('<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>'),
  history: renderIcon(
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M12 7.5V12l3.2 1.9"/>',
  ),
  panelLeft: renderIcon(
    '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M9.5 4.5v15"/>',
  ),
  messagePlus: renderIcon(
    '<path d="M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.3 0-2.5-.3-3.6-.8L3 20.5l1.5-4.4A8.5 8.5 0 1 1 20.5 11.5z"/>' +
      '<path d="M12 8.5v6"/><path d="M9 11.5h6"/>',
  ),

  // ── 工具 ──

  // 扳手：开口爪 + 手柄
  wrench: renderIcon(
    '<path d="M14.5 4.2a4.8 4.8 0 0 0-5.6 6.9l-5.4 5.4a2 2 0 0 0 0 2.8l1.2 1.2a2 2 0 0 0 2.8 0l5.4-5.4a4.8 4.8 0 0 0 6.9-5.6l-3 3-2.6-.7-.7-2.6z"/>',
  ),
  // 编辑（铅笔 + 基线）
  edit: renderIcon(
    '<path d="M12 20h9"/><path d="M16.6 3.4a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5z"/>',
  ),
  paperclip: renderIcon(
    '<path d="m20.5 11-8.8 8.8a5.7 5.7 0 0 1-8-8l8.7-8.7a3.8 3.8 0 0 1 5.4 5.4l-8.7 8.7a1.9 1.9 0 0 1-2.7-2.7l8-8"/>',
  ),
  globe: renderIcon(
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.7 2.5 4 5.5 4 9s-1.3 6.5-4 9c-2.7-2.5-4-5.5-4-9s1.3-6.5 4-9z"/>',
  ),
  image: renderIcon(
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m4.5 18.5 5.8-5.8a1.4 1.4 0 0 1 2 0l7.2 7.2"/>',
  ),
  // 拼图块：顶部与右侧凸起
  puzzle: renderIcon(
    '<path d="M5 5.5h4.5V7a2 2 0 1 0 4 0V5.5H18a1.5 1.5 0 0 1 1.5 1.5v4.5H18a2 2 0 1 0 0 4h1.5V20a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 20z"/>',
  ),
  externalLink: renderIcon(
    '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M18.5 13.5V19A1.5 1.5 0 0 1 17 20.5H6A1.5 1.5 0 0 1 4.5 19V8A1.5 1.5 0 0 1 6 6.5h5.5"/>',
  ),
  send: renderIcon(
    '<path d="M21 3 10.8 13.2"/><path d="M21 3 14.2 21l-3.4-7.8L3 9.8z"/>',
  ),
  cpu: renderIcon(
    '<rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="10" y="10" width="4" height="4"/>' +
      '<path d="M9 2.5V6"/><path d="M15 2.5V6"/><path d="M9 18v3.5"/><path d="M15 18v3.5"/>' +
      '<path d="M2.5 9H6"/><path d="M2.5 15H6"/><path d="M18 9h3.5"/><path d="M18 15h3.5"/>',
  ),
  database: renderIcon(
    '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  ),
  // 仪表盘：四宫格
  layout: renderIcon(
    '<rect x="3.5" y="3.5" width="7" height="9" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.2"/>' +
      '<rect x="13.5" y="11.5" width="7" height="9" rx="1.2"/><rect x="3.5" y="15.5" width="7" height="5" rx="1.2"/>',
  ),
  server: renderIcon(
    '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/>' +
      '<path d="M7 7.5h.01"/><path d="M7 16.5h.01"/>',
  ),
  terminal: renderIcon('<path d="m5 7.5 5 5-5 5"/><path d="M12.5 17.5H19"/>'),

  // ── 会话管理 / 任务视图 ──

  pin: renderIcon(
    '<path d="M12 17v4.5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.3v.7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.7a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>',
  ),
  // pin 的激活（已置顶）态：填充为唯一有意的视觉差异
  pinActive: html`
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 17v4.5" />
      <path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.3v.7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.7a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
    </svg>
  `,
  eye: renderIcon(
    '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  ),
  eyeOff: renderIcon(
    '<path d="M4 4l16 16"/>' +
      '<path d="M10.6 6c.5-.1 1-.1 1.4-.1 6 0 9.5 6.1 9.5 6.1a16.8 16.8 0 0 1-2.7 3.3M6.6 7A16.5 16.5 0 0 0 2.5 12S6 18.1 12 18.1c1.2 0 2.3-.3 3.3-.7"/>' +
      '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  ),
  archive: renderIcon(
    '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M10 13.5h4"/>',
  ),
  archiveRestore: renderIcon(
    '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9"/>' +
      '<path d="M12 16.5v-5"/><path d="m9 13.5 3-3 3 3"/>',
  ),
  trash: renderIcon(
    '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/>' +
      '<path d="M5.5 7l.9 12a1.5 1.5 0 0 0 1.5 1.4h8.2a1.5 1.5 0 0 0 1.5-1.4l.9-12"/>' +
      '<path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
  ),
  // 三点（填充圆点为唯一例外）
  moreHorizontal: renderIcon(
    '<circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  ),
  list: renderIcon(
    '<path d="M8.5 6h12"/><path d="M8.5 12h12"/><path d="M8.5 18h12"/>' +
      '<path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/>',
  ),
  // 脉搏
  activity: renderIcon('<path d="M2.5 12h4l2.5-7 5 14 2.5-7h5"/>'),
  folder: renderIcon(
    '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/>',
  ),
  folderOpen: renderIcon(
    '<path d="M3.5 18V6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v1"/>' +
      '<path d="m3.5 18 2-6.5A1.5 1.5 0 0 1 7 10h13.5a1.5 1.5 0 0 1 1.4 2l-2 6.5a1.5 1.5 0 0 1-1.4 1H5A1.5 1.5 0 0 1 3.5 18z"/>',
  ),
  // worktree 会话徽标 / worktrees 管理入口
  gitBranch: renderIcon(
    '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/>' +
      '<path d="M6 8.5v7"/><path d="M18 10.5a8 8 0 0 1-9.5 7.7"/>',
  ),
  // git 面板（索引/审查/提交）入口：左减右增双栏
  diff: renderIcon(
    '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M12 4.5v15"/>' +
      '<path d="M6.5 12h3"/><path d="M14.5 10.5v3"/><path d="M13 12h3"/>',
  ),
  // cron 详情「立即运行」
  play: renderIcon('<path d="M7 4.5 19 12 7 19.5z"/>'),
} as const;

export type IconName = keyof typeof icons;

export function icon(name: IconName): TemplateResult {
  return icons[name];
}
