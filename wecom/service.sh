#!/bin/bash
# 企业微信 Cursor Remote Control 服务管理脚本
# 基于 macOS launchd 实现开机自启动和崩溃自动恢复

set -e

# ===== 配置 =====
SERVICE_NAME="com.wecom-cursor-claw"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
LOG_PATH="/tmp/wecom-cursor.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_PATH="$(which bun)"
START_SCRIPT="$SCRIPT_DIR/start-with-keepawake.ts"

# ===== 函数定义 =====
function create_plist() {
    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BUN_PATH}</string>
        <string>run</string>
        <string>${START_SCRIPT}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_PATH}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${HOME}/.bun/bin:${HOME}/.local/bin</string>
    </dict>
</dict>
</plist>
EOF
}

function install_service() {
    echo "📦 正在安装企业微信服务..."
    
    # 创建 plist
    create_plist
    
    # 加载服务
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"
    
    echo "✅ 服务已安装并启动"
    echo "   标签: ${SERVICE_NAME}"
    echo "   日志: ${LOG_PATH}"
    echo ""
    echo "查看日志: bash service.sh logs"
    echo "查看状态: bash service.sh status"
}

function uninstall_service() {
    echo "🗑️  正在卸载企业微信服务..."
    
    if [ -f "$PLIST_PATH" ]; then
        launchctl unload "$PLIST_PATH" 2>/dev/null || true
        rm -f "$PLIST_PATH"
        echo "✅ 服务已卸载"
    else
        echo "ℹ️  服务未安装"
    fi
}

function start_service() {
    if launchctl list | grep -q "$SERVICE_NAME"; then
        echo "ℹ️  服务已在运行"
    else
        launchctl load "$PLIST_PATH"
        echo "✅ 服务已启动"
    fi
}

function stop_service() {
    echo "⏹️  正在停止企业微信服务..."
    
    # 停止 launchd 服务
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    
    # 强制杀死所有相关进程
    pkill -f "bun.*wecom.*start" || true
    pkill -f "caffeinate.*bun.*start" || true
    
    echo "✅ 服务已停止"
}

function restart_service() {
    echo "🔄 正在重启企业微信服务..."
    stop_service
    sleep 2
    start_service
}

function show_status() {
    echo "📊 企业微信服务状态:"
    echo ""
    
    if launchctl list | grep -q "$SERVICE_NAME"; then
        PID=$(launchctl list | grep "$SERVICE_NAME" | awk '{print $1}')
        if [ "$PID" != "-" ]; then
            echo "🟢 运行中 (PID: $PID)"
        else
            echo "🟡 已加载但未运行"
        fi
    else
        echo "⚪ 未运行"
    fi
    
    echo ""
    echo "配置:"
    echo "  plist: $PLIST_PATH"
    echo "  日志:  $LOG_PATH"
    echo ""
    
    if [ -f "$LOG_PATH" ]; then
        echo "最近日志:"
        tail -10 "$LOG_PATH"
    fi
}

function show_logs() {
    if [ ! -f "$LOG_PATH" ]; then
        echo "❌ 日志文件不存在: $LOG_PATH"
        exit 1
    fi
    
    echo "📄 实时日志 (Ctrl+C 退出):"
    echo ""
    tail -f "$LOG_PATH"
}

# ===== 主逻辑 =====
case "${1:-}" in
    install)
        install_service
        ;;
    uninstall)
        uninstall_service
        ;;
    start)
        start_service
        ;;
    stop)
        stop_service
        ;;
    restart)
        restart_service
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    *)
        echo "企业微信 Cursor Remote Control 服务管理"
        echo ""
        echo "用法: bash service.sh {install|uninstall|start|stop|restart|status|logs}"
        echo ""
        echo "命令:"
        echo "  install    安装开机自启动并立即启动"
        echo "  uninstall  卸载自启动并停止服务"
        echo "  start      启动服务"
        echo "  stop       停止服务"
        echo "  restart    重启服务"
        echo "  status     查看运行状态"
        echo "  logs       查看实时日志"
        exit 1
        ;;
esac
