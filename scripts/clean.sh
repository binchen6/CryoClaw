#!/usr/bin/env bash
set -euo pipefail

# clean.sh — 清理 CryoClaw 的"运行痕迹"，用于"第一次启动"测试（含 Setup 向导）。
#
# 与 `npm run clean`（scripts/clean.js）同名不同命，注意区分：
#   - `npm run clean`：只删**构建产物**（dist / resources 运行时与内核 / 各 target /
#     out / .test-dist 等），不碰用户数据，无需确认。
#   - 本脚本：删**用户数据**——~/.openclaw（含凭据、对话历史、工作区）与 macOS
#     应用偏好/缓存。不可恢复，因此默认要求交互确认，非交互环境必须显式 --yes。
#
# 仅适用于 macOS（依赖 killall / defaults / ~/Library）：在 Windows/Linux 上除
# ~/.openclaw 以外的删除都是空操作，等于只删用户数据，不要在其他平台运行。
#
# 用法: scripts/clean.sh [--dry-run] [--yes]

usage() {
  cat <<'EOF'
清理 CryoClaw 的用户数据与运行痕迹（macOS，用于"第一次启动"测试）

要删除的内容（不可恢复）：
  ~/.openclaw        凭据、对话历史、工作区
  ~/Library/...      应用偏好与缓存（com.cryoclaw.app）

只删构建产物请用 `npm run clean`（dist / resources / out 等），它不需要确认。

用法: scripts/clean.sh [--dry-run] [--yes]
  --dry-run   只打印要删除的内容，不执行，也不询问确认
  --yes       跳过 ~/.openclaw 的确认提示（非交互环境必需）
  -h, --help  显示本帮助
EOF
}

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      echo >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$DRY_RUN" == "1" ]]; then
  echo "=== DRY RUN — 只打印要删除的内容，不执行 ==="
fi

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  [dry] $*"
  else
    "$@"
  fi
}

BUNDLE_ID="com.cryoclaw.app"
STATE_DIR="$HOME/.openclaw"

# 用户数据确认门：~/.openclaw 含凭据与对话历史，删除不可恢复。放在一切删除动作之前，
# 取消即整体退出（不做半程清理，也不终止正在运行的 CryoClaw）。
confirm_user_data_wipe() {
  if [[ "$ASSUME_YES" == "1" ]]; then
    echo "--yes 已指定，跳过删除确认"
    return 0
  fi

  # 非交互环境（脚本 / CI / 管道）默认拒绝：宁可不清理，也不能一次误调用清空用户数据
  if [[ ! -t 0 ]]; then
    echo "拒绝删除 $STATE_DIR：stdin 不是终端（非交互环境）" >&2
    echo "确认要清空用户数据后，请显式加 --yes 重跑。" >&2
    return 1
  fi

  echo "将删除 ~/.openclaw（含凭据与对话历史），目标路径: $STATE_DIR"
  local answer=""
  read -r -p "输入 yes 继续（其他任意输入取消）: " answer || true
  if [[ "$answer" == "yes" ]]; then
    return 0
  fi
  echo "已取消，未删除任何内容。"
  return 1
}

# --dry-run 不删任何东西，无需确认；其余情况必须过确认门
if [[ "$DRY_RUN" != "1" ]] && ! confirm_user_data_wipe; then
  exit 1
fi

# 终止 CryoClaw 进程（包括 Electron 主进程和 gateway 子进程）
echo "终止 CryoClaw 进程"
run killall CryoClaw 2>/dev/null || true
run killall -9 CryoClaw 2>/dev/null || true
sleep 0.5

# 清理 Electron UserDefaults / 应用缓存
echo "清理 Electron 应用数据"
run defaults delete "$BUNDLE_ID" 2>/dev/null || true
run rm -f "$HOME/Library/Preferences/$BUNDLE_ID.plist"
run rm -f "$HOME/Library/Preferences/ByHost/$BUNDLE_ID."*.plist 2>/dev/null || true
run rm -rf "$HOME/Library/Caches/$BUNDLE_ID"
run rm -rf "$HOME/Library/Saved Application State/$BUNDLE_ID.savedState"
run rm -rf "$HOME/Library/HTTPStorages/$BUNDLE_ID"
run rm -rf "$HOME/Library/HTTPStorages/$BUNDLE_ID.binarycookies"
run rm -rf "$HOME/Library/WebKit/$BUNDLE_ID"
run rm -rf "$HOME/Library/Application Support/$BUNDLE_ID"

# 刷新偏好设置缓存（cfprefsd 会被 launchd 自动重启）
echo "刷新偏好设置缓存"
run killall cfprefsd 2>/dev/null || true

# 清理 openclaw 共享数据（~/.openclaw/ 含 openclaw.json 配置、凭据与对话历史；开头已确认）
echo "清理 openclaw 共享数据"
run rm -rf "$STATE_DIR"

echo "清理完成。可以执行全新 Setup 测试了。"
