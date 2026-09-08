#!/usr/bin/env bash

set -u

# 并行启动四个目标打包任务，保留每个任务独立退出码。
#
# 构建串行化（R60 修正）：四个 dist:* npm script 各自以 `npm run build &&` 开头，
# 而它们共享同一批构建输出目录（chat-ui/ui/dist、chat-ui/ui/node_modules、dist/、
# tsconfig.tsbuildinfo）。四路并发 build 会互相践踏（并发 npm install / vite 产物 /
# tsc 增量状态），产物不可复现且偶发损坏。因此先串行跑一次全量 build，再并行
# 执行各目标的 package:resources + electron-builder（这两个阶段按目标隔离目录）。

declare -a TASKS=(
  "dist:mac:arm64"
  "dist:mac:x64"
  "dist:win:x64"
  "dist:win:arm64"
)

echo "[parallel] 串行执行共享构建（npm run build）..."
if ! npm run build; then
  echo "[parallel] 共享构建失败，中止"
  exit 1
fi

# 并行阶段：跳过各 script 内嵌的 `npm run build &&` 前缀，直接执行打包段。
# 各 dist:* script 的打包段 = package:resources（带目标 env）+ builder（带目标 env）。
package_task() {
  local name="$1"
  local target
  local platform
  local arch
  local builder_cmd
  case "${name}" in
    dist:mac:arm64) target="darwin-arm64"; platform="darwin"; arch="arm64"; builder_cmd="node scripts/run-with-env.js node scripts/run-mac-builder.js --arch arm64 --output out/darwin-arm64" ;;
    dist:mac:x64)   target="darwin-x64";   platform="darwin"; arch="x64";   builder_cmd="node scripts/run-with-env.js node scripts/run-mac-builder.js --arch x64 --output out/darwin-x64" ;;
    dist:win:x64)   target="win32-x64";    platform="win32"; arch="x64";   builder_cmd="npx electron-builder --win --x64 --config.directories.output=out/win32-x64 --publish never" ;;
    dist:win:arm64) target="win32-arm64";  platform="win32"; arch="arm64"; builder_cmd="npx electron-builder --win --arm64 --config.directories.output=out/win32-arm64 --publish never" ;;
    *) echo "[parallel] 未知任务 ${name}"; return 1 ;;
  esac
  echo "[parallel] start ${name}"
  CRYOCLAW_TARGET="${target}" npm run package:resources -- --platform "${platform}" --arch "${arch}" \
    && CRYOCLAW_TARGET="${target}" ${builder_cmd}
}

declare -a PIDS=()
declare -a NAMES=()

# 启动单个打包任务并记录 pid。
start_task() {
  local name="$1"
  package_task "${name}" &
  PIDS+=("$!")
  NAMES+=("${name}")
}

# 遍历任务列表并行启动。
for task in "${TASKS[@]}"; do
  start_task "${task}"
done

FAILED=0

# 等待所有任务结束并汇总失败项。
for index in "${!PIDS[@]}"; do
  pid="${PIDS[$index]}"
  name="${NAMES[$index]}"
  if wait "${pid}"; then
    echo "[parallel] done ${name}"
  else
    echo "[parallel] fail ${name}"
    FAILED=1
  fi
done

if [[ "${FAILED}" -ne 0 ]]; then
  echo "[parallel] 至少一个打包任务失败"
  exit 1
fi

echo "[parallel] 四个目标打包全部完成"
