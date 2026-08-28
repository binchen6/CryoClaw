import { html, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import {
  Activity,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Brain,
  Check,
  Clock,
  Copy,
  Cpu,
  Database,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  History,
  Image,
  LayoutDashboard,
  List,
  Loader,
  MessageSquarePlus,
  Monitor,
  PanelLeft,
  Paperclip,
  Pin,
  Plus,
  Puzzle,
  Quote,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Server,
  Settings,
  Square,
  SquarePen,
  Terminal,
  Trash,
  TriangleAlert,
  Wrench,
  X,
  Zap,
} from "lucide";

// Lucide-style SVG icons
// All icons use currentColor for stroke

function renderLucideIcon(iconNode: any[]): TemplateResult {
  const innerHtml = iconNode.map(([tag, attrs]: [string, any]) => {
    const attrString = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ");
    return `<${tag} ${attrString}></${tag}>`;
  }).join("");
  return html`${unsafeSVG(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${innerHtml}</svg>`)}`;
}

export const icons = {
  // Navigation icons
  // 消息引用（quote 文本样式）
  quote: renderLucideIcon(Quote),
  // 重发（rotate-ccw 回旋箭头）
  rotateCcw: renderLucideIcon(RotateCcw),
  fileText: renderLucideIcon(FileText),
  zap: renderLucideIcon(Zap),
  monitor: renderLucideIcon(Monitor),
  settings: renderLucideIcon(Settings),

  // UI icons
  x: renderLucideIcon(X),
  check: renderLucideIcon(Check),
  warning: renderLucideIcon(TriangleAlert),
  plus: renderLucideIcon(Plus),
  arrowDown: renderLucideIcon(ArrowDown),
  arrowLeft: renderLucideIcon(ArrowLeft),
  arrowUp: renderLucideIcon(ArrowUp),
  copy: renderLucideIcon(Copy),
  refreshCw: renderLucideIcon(RefreshCw),
  search: renderLucideIcon(Search),
  brain: renderLucideIcon(Brain),
  loader: renderLucideIcon(Loader),
  clock: renderLucideIcon(Clock),
  stop: renderLucideIcon(Square),
  history: renderLucideIcon(History),
  panelLeft: renderLucideIcon(PanelLeft),
  messagePlus: renderLucideIcon(MessageSquarePlus),

  // Tool icons
  wrench: renderLucideIcon(Wrench),
  edit: renderLucideIcon(SquarePen),
  paperclip: renderLucideIcon(Paperclip),
  globe: renderLucideIcon(Globe),
  image: renderLucideIcon(Image),
  puzzle: renderLucideIcon(Puzzle),
  externalLink: renderLucideIcon(ExternalLink),
  send: renderLucideIcon(Send),
  cpu: renderLucideIcon(Cpu),
  database: renderLucideIcon(Database),
  layout: renderLucideIcon(LayoutDashboard),
  server: renderLucideIcon(Server),
  terminal: renderLucideIcon(Terminal),

  // 会话管理 / 任务视图图标
  pin: renderLucideIcon(Pin),
  // pin 的激活（已置顶）态：lucide 没有填充版 Pin，保留手绘。
  // 已按 lucide 规范对齐（24x24 viewBox、stroke-width 2、round linecap/linejoin），
  // 仅 fill="currentColor" 为有意保留的“激活”视觉差异，无法用 lucide 表达。
  pinActive: html`
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
    </svg>
  `,
  eye: renderLucideIcon(Eye),
  eyeOff: renderLucideIcon(EyeOff),
  archive: renderLucideIcon(Archive),
  archiveRestore: renderLucideIcon(ArchiveRestore),
  trash: renderLucideIcon(Trash),
  moreHorizontal: renderLucideIcon(Ellipsis),
  list: renderLucideIcon(List),
  activity: renderLucideIcon(Activity),
  folder: renderLucideIcon(Folder),
  folderOpen: renderLucideIcon(FolderOpen),
  // worktree 会话徽标 / worktrees 管理入口
  gitBranch: renderLucideIcon(GitBranch),
} as const;

export type IconName = keyof typeof icons;

export function icon(name: IconName): TemplateResult {
  return icons[name];
}

// Legacy function for compatibility
export function renderEmojiIcon(
  iconContent: string | TemplateResult,
  className: string,
): TemplateResult {
  return html`<span class=${className} aria-hidden="true">${iconContent}</span>`;
}

export function setEmojiIcon(target: HTMLElement | null, icon: string): void {
  if (!target) {
    return;
  }
  target.textContent = icon;
}
