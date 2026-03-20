#!/bin/bash
# Cursor Remote Control 服务管理脚本
# 用法: bash manage-services.sh [start|stop|restart|status]

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

start_services() {
    echo "🚀 启动所有服务..."
    
    cd "$PROJECT_ROOT/feishu"
    nohup bun run start-with-keepawake.ts > /tmp/feishu-cursor.log 2>&1 &
    echo "  ✅ 飞书服务已启动 (PID: $!)"
    
    cd "$PROJECT_ROOT/dingtalk"
    nohup bun run start-with-keepawake.ts > /tmp/dingtalk-cursor.log 2>&1 &
    echo "  ✅ 钉钉服务已启动 (PID: $!)"
    
    cd "$PROJECT_ROOT/wecom"
    nohup bun run start-with-keepawake.ts > /tmp/wecom-cursor.log 2>&1 &
    echo "  ✅ 企业微信服务已启动 (PID: $!)"
    
    sleep 3
    echo ""
    echo "✅ 所有服务已启动"
}

stop_services() {
    echo "🛑 停止所有服务..."
    
    pkill -9 -f "cursor-remote-control/(feishu|dingtalk|wecom)" 2>/dev/null || true
    sleep 2
    
    REMAINING=$(pgrep -f "cursor-remote-control/(feishu|dingtalk|wecom)" 2>/dev/null | wc -l || echo "0")
    if [[ "$REMAINING" -eq 0 ]]; then
        echo "  ✅ 所有服务已停止"
    else
        echo "  ⚠️  还有 $REMAINING 个残留进程"
    fi
}

show_status() {
    echo "📊 服务状态:"
    echo ""
    
    echo "【进程】"
    FEISHU_PID=$(pgrep -f 'feishu/start.ts' | head -1 || echo "")
    DINGTALK_PID=$(pgrep -f 'dingtalk/start.ts' | head -1 || echo "")
    WECOM_PID=$(pgrep -f 'wecom/start.ts' | grep -v keepawake | head -1 || echo "")
    
    if [[ -n "$FEISHU_PID" ]]; then
        FEISHU_CAFF=$(pgrep -f "caffeinate.*feishu" | head -1 || echo "")
        echo "  🟢 飞书:     PID $FEISHU_PID (caffeinate: $FEISHU_CAFF)"
    else
        echo "  🔴 飞书:     未运行"
    fi
    
    if [[ -n "$DINGTALK_PID" ]]; then
        DINGTALK_CAFF=$(pgrep -f "caffeinate.*dingtalk" | head -1 || echo "")
        echo "  🟢 钉钉:     PID $DINGTALK_PID (caffeinate: $DINGTALK_CAFF)"
    else
        echo "  🔴 钉钉:     未运行"
    fi
    
    if [[ -n "$WECOM_PID" ]]; then
        WECOM_CAFF=$(pgrep -f "caffeinate.*wecom" | head -1 || echo "")
        echo "  🟢 企业微信: PID $WECOM_PID (caffeinate: $WECOM_CAFF)"
    else
        echo "  🔴 企业微信: 未运行"
    fi
    
    echo ""
    echo "【防休眠】"
    CAFF_COUNT=$(pmset -g assertions | grep -c "caffeinate" || echo "0")
    echo "  ✅ $CAFF_COUNT 个 caffeinate 进程正在防止系统休眠"
    
    echo ""
    echo "【日志】"
    echo "  飞书:     tail -f /tmp/feishu-cursor.log"
    echo "  钉钉:     tail -f /tmp/dingtalk-cursor.log"
    echo "  企业微信: tail -f /tmp/wecom-cursor.log"
}

case "${1:-}" in
    start)
        stop_services
        sleep 2
        start_services
        echo ""
        show_status
        ;;
    stop)
        stop_services
        ;;
    restart)
        stop_services
        sleep 2
        start_services
        echo ""
        show_status
        ;;
    status)
        show_status
        ;;
    *)
        echo "Cursor Remote Control 服务管理"
        echo ""
        echo "用法: bash manage-services.sh <命令>"
        echo ""
        echo "命令:"
        echo "  start    启动所有服务"
        echo "  stop     停止所有服务"
        echo "  restart  重启所有服务"
        echo "  status   查看服务状态"
        echo ""
        echo "快速查看状态:"
        echo "  bash manage-services.sh status"
        ;;
esac
