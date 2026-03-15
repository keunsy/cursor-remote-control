#!/bin/bash
# 可靠的服务重启脚本
# 解决进程清理不干净的问题

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "🔄 重启 Cursor Remote Control 服务..."
echo ""

# ========================================
# 1. 彻底清理所有相关进程
# ========================================
echo "🛑 停止所有服务进程..."

declare -a ALL_PIDS=()

# 方法1：路径匹配
while IFS= read -r pid; do
    [[ -n "$pid" ]] && ALL_PIDS+=("$pid")
done < <(pgrep -f "cursor-remote-control/(feishu|dingtalk)" 2>/dev/null || true)

# 方法2：lsof 工作目录匹配
for dir in "$PROJECT_ROOT/feishu" "$PROJECT_ROOT/dingtalk"; do
    if [[ -d "$dir" ]]; then
        while IFS= read -r pid; do
            [[ -n "$pid" ]] && ALL_PIDS+=("$pid")
        done < <(lsof +D "$dir" 2>/dev/null | awk 'NR>1 {print $2}' | sort -u || true)
    fi
done

# 去重
ALL_PIDS=($(printf "%s\n" "${ALL_PIDS[@]}" | sort -u))

if [[ ${#ALL_PIDS[@]} -gt 0 ]]; then
    echo "  🔪 清理 ${#ALL_PIDS[@]} 个进程: ${ALL_PIDS[*]}"
    for pid in "${ALL_PIDS[@]}"; do
        kill -9 "$pid" 2>/dev/null || true
    done
    echo "  ✅ 进程已清理"
else
    echo "  ℹ️  没有运行中的进程"
fi

sleep 2

# ========================================
# 2. 验证清理结果
# ========================================
REMAINING=$(pgrep -f "cursor-remote-control/(feishu|dingtalk)" 2>/dev/null | wc -l || echo "0")
if [[ "$REMAINING" -ne 0 ]]; then
    echo "  ⚠️  警告：还有 $REMAINING 个残留进程"
    pgrep -fl "cursor-remote-control/(feishu|dingtalk)" || true
    exit 1
fi

echo "  ✅ 进程清理完成"
echo ""

# ========================================
# 3. 启动新服务
# ========================================
echo "🚀 启动服务..."

cd "$PROJECT_ROOT/feishu"
nohup bun run start-with-keepawake.ts > /tmp/feishu-cursor.log 2>&1 &
FEISHU_PID=$!
echo "  ✅ 飞书服务已启动 (PID: $FEISHU_PID)"

cd "$PROJECT_ROOT/dingtalk"
nohup bun run start-with-keepawake.ts > /tmp/dingtalk-cursor.log 2>&1 &
DINGTALK_PID=$!
echo "  ✅ 钉钉服务已启动 (PID: $DINGTALK_PID)"

sleep 2

# ========================================
# 4. 验证启动结果
# ========================================
echo ""
echo "📊 当前服务状态:"
RUNNING=$(ps aux | grep -E "cursor-remote-control/(feishu|dingtalk)" | grep -v grep | wc -l || echo "0")
echo "  🟢 运行中的进程: $RUNNING 个"

if [[ "$RUNNING" -lt 2 ]]; then
    echo "  ⚠️  警告：进程数少于预期（应该≥4）"
fi

ps aux | grep -E "cursor-remote-control/(feishu|dingtalk)" | grep -v grep || true

echo ""
echo "📝 日志:"
echo "  飞书: tail -f /tmp/feishu-cursor.log"
echo "  钉钉: tail -f /tmp/dingtalk-cursor.log"
echo ""
echo "✅ 重启完成"
