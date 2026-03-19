#!/bin/bash
# 彻底清理服务进程（解决嵌套进程清理不干净的问题）
# 用法: bash kill-service.sh feishu|dingtalk|wecom

set -e

SERVICE="${1:-}"

if [[ "$SERVICE" != "feishu" && "$SERVICE" != "dingtalk" && "$SERVICE" != "wecom" ]]; then
    echo "❌ 用法: bash kill-service.sh [feishu|dingtalk|wecom]"
    exit 1
fi

echo "🔍 查找 $SERVICE 相关进程..."

# 收集所有相关 PID
declare -a PIDS=()

# 1. 匹配路径中包含服务名的所有进程
while IFS= read -r pid; do
    [[ -n "$pid" ]] && PIDS+=("$pid")
done < <(pgrep -f "cursor-remote-control/$SERVICE" 2>/dev/null || true)

# 2. 通过 lsof 查找工作目录在服务目录下的进程
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$SCRIPT_DIR/$SERVICE"
if [[ -d "$SERVICE_DIR" ]]; then
    while IFS= read -r pid; do
        [[ -n "$pid" ]] && PIDS+=("$pid")
    done < <(lsof +D "$SERVICE_DIR" 2>/dev/null | awk 'NR>1 {print $2}' | sort -u || true)
fi

# 去重
PIDS=($(printf "%s\n" "${PIDS[@]}" | sort -u))

if [[ ${#PIDS[@]} -eq 0 ]]; then
    echo "  ✅ 没有找到运行中的 $SERVICE 进程"
    exit 0
fi

echo "  📋 找到 ${#PIDS[@]} 个进程: ${PIDS[*]}"

# 杀掉所有进程
for pid in "${PIDS[@]}"; do
    if ps -p "$pid" > /dev/null 2>&1; then
        echo "  🔪 杀进程 $pid"
        kill -9 "$pid" 2>/dev/null || true
    fi
done

# 等待并验证
sleep 1

# 验证是否清理干净
REMAINING=$(pgrep -f "cursor-remote-control/$SERVICE" 2>/dev/null | wc -l || echo "0")
if [[ "$REMAINING" -eq 0 ]]; then
    echo "  ✅ $SERVICE 服务进程已完全清理"
else
    echo "  ⚠️  还有 $REMAINING 个残留进程"
    pgrep -fl "cursor-remote-control/$SERVICE" || true
fi
