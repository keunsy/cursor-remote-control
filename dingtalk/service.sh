#!/bin/bash
# dingtalk-cursor-claw 服务管理脚本
# 用法: bash service.sh [install|uninstall|start|stop|restart|status|logs]
#
# 功能：
# ✅ caffeinate 防休眠（通过 start-with-keepawake.ts）
# ✅ 清理历史进程（stop 时 pkill 清理残留）
# ✅ 开机自启动（launchd RunAtLoad + KeepAlive）
set -e

LABEL="com.dingtalk-cursor-claw"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUN_BIN="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
LOG_FILE="/tmp/dingtalk-cursor.log"

generate_plist() {
    cat > "$PLIST" <<PEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>

	<key>ProgramArguments</key>
	<array>
		<string>$BUN_BIN</string>
		<string>run</string>
		<string>start-with-keepawake.ts</string>
	</array>

	<key>WorkingDirectory</key>
	<string>$BOT_DIR</string>

	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>$HOME</string>
		<key>PATH</key>
		<string>$(dirname "$BUN_BIN"):$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>

	<key>RunAtLoad</key>
	<true/>

	<key>KeepAlive</key>
	<true/>

	<key>StandardOutPath</key>
	<string>$LOG_FILE</string>
	<key>StandardErrorPath</key>
	<string>$LOG_FILE</string>

	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
PEOF
    echo "  ✅ plist 已生成: $PLIST"
}

cmd_install() {
    echo "📦 安装开机自启动..."
    generate_plist
    # 使用 load -w 而不是 bootstrap（兼容性更好）
    launchctl load -w "$PLIST" 2>&1
    echo "  ✅ 服务已安装并启动"
    echo "  📝 日志: tail -f $LOG_FILE"
}

cmd_uninstall() {
    echo "🗑  卸载自启动..."
    launchctl unload -w "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "  ✅ 服务已卸载"
}

cmd_start() {
    if launchctl print "gui/$(id -u)/$LABEL" &>/dev/null; then
        launchctl kickstart -k "gui/$(id -u)/$LABEL"
        echo "  ✅ 服务已启动"
    else
        echo "  ⚠️  服务未安装，先运行: bash service.sh install"
    fi
}

cmd_stop() {
    echo "🛑 停止服务..."
    
    # 先通过 launchd 停止（会触发 SIGTERM，进程锁会自动清理）
    if launchctl print "gui/$(id -u)/$LABEL" &>/dev/null; then
        launchctl kill SIGTERM "gui/$(id -u)/$LABEL" 2>/dev/null
        echo "  ✅ 已发送停止信号"
        # 等待进程优雅退出
        sleep 2
    else
        echo "  ⚠️  launchd 服务未在运行"
    fi
    
    # 仅清理确实残留的进程（通过精确路径匹配 start.ts 和 server.ts）
    local PIDS=($(pgrep -f "bun run.*dingtalk/(start|server)" 2>/dev/null || true))
    
    if [[ ${#PIDS[@]} -gt 0 ]]; then
        echo "  🔪 清理 ${#PIDS[@]} 个残留进程"
        for pid in "${PIDS[@]}"; do
            kill -9 "$pid" 2>/dev/null || true
        done
    fi
    
    # 清理进程锁文件（如果存在）
    rm -f /tmp/cursor-dingtalk.pid 2>/dev/null || true
    
    echo "  ✅ 服务已完全停止"
}

cmd_restart() {
    echo "🔄 重启服务..."
    cmd_stop
    sleep 2
    cmd_start
}

cmd_status() {
    echo "📊 服务状态:"
    if launchctl print "gui/$(id -u)/$LABEL" &>/dev/null; then
        PID=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep 'pid =' | awk '{print $3}')
        if [[ -n "$PID" && "$PID" != "0" ]]; then
            echo "  🟢 运行中 (PID: $PID)"
        else
            echo "  🔴 已停止（launchd 管理中）"
        fi
        echo "  📋 标签: $LABEL"
        echo "  📁 工作目录: $BOT_DIR"
        echo "  📝 日志: $LOG_FILE"
    else
        echo "  ⚪ 未安装"
        echo "  💡 运行 'bash service.sh install' 安装"
    fi
}

cmd_logs() {
    if [[ -f "$LOG_FILE" ]]; then
        tail -f "$LOG_FILE"
    else
        echo "  ⚠️  日志文件不存在: $LOG_FILE"
    fi
}

case "${1:-}" in
    install)   cmd_install ;;
    uninstall) cmd_uninstall ;;
    start)     cmd_start ;;
    stop)      cmd_stop ;;
    restart)   cmd_restart ;;
    status)    cmd_status ;;
    logs)      cmd_logs ;;
    *)
        echo "dingtalk-cursor-claw 服务管理"
        echo ""
        echo "用法: bash service.sh <命令>"
        echo ""
        echo "命令:"
        echo "  install     安装开机自启动并立即启动"
        echo "  uninstall   卸载自启动并停止服务"
        echo "  start       启动服务"
        echo "  stop        停止服务"
        echo "  restart     重启服务"
        echo "  status      查看服务状态"
        echo "  logs        查看实时日志"
        ;;
esac
