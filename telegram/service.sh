#!/bin/bash

# Telegram 服务管理脚本

PID_FILE="/tmp/cursor-telegram.pid"

start() {
    if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
        echo "❌ Telegram 服务已在运行 (PID: $(cat $PID_FILE))"
        exit 1
    fi
    
    echo "🚀 启动 Telegram 服务..."
    cd "$(dirname "$0")"
    nohup bun run server.ts > telegram.log 2>&1 &
    echo $! > "$PID_FILE"
    echo "✅ 服务已启动 (PID: $(cat $PID_FILE))"
    echo "📋 日志: telegram.log"
}

stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "⚠️  服务未运行"
        exit 0
    fi
    
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "🛑 停止服务 (PID: $PID)..."
        kill "$PID"
        rm -f "$PID_FILE"
        echo "✅ 服务已停止"
    else
        echo "⚠️  进程不存在，清理 PID 文件"
        rm -f "$PID_FILE"
    fi
}

restart() {
    stop
    sleep 1
    start
}

status() {
    if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
        echo "✅ 服务运行中 (PID: $(cat $PID_FILE))"
    else
        echo "❌ 服务未运行"
    fi
}

logs() {
    tail -f telegram.log
}

case "$1" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    status)
        status
        ;;
    logs)
        logs
        ;;
    *)
        echo "用法: $0 {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
