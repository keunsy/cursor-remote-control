#!/bin/bash
# Cursor Remote Control 服务管理脚本（增强版）
# 支持两种运行模式：
#   1. 简单模式（nohup）：适合开发测试
#   2. 系统服务（launchd）：适合生产环境，开机自启、崩溃自动重启
#
# 用法: bash manage-services.sh <命令>

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
SERVICES=(
    "com.cursor-feishu"
    "com.dingtalk-cursor-claw"
    "com.wecom-cursor-claw"
)

# 检测是否已安装为 launchd 服务
is_launchd_installed() {
    for service in "${SERVICES[@]}"; do
        if [ -f "$PLIST_DIR/$service.plist" ]; then
            return 0
        fi
    done
    return 1
}

# 检测当前运行模式
detect_mode() {
    if is_launchd_installed; then
        # 检查是否有 launchd 管理的进程在运行
        for service in "${SERVICES[@]}"; do
            if launchctl list | grep -q "$service"; then
                echo "launchd"
                return
            fi
        done
    fi
    
    # 检查是否有手动启动的进程
    if pgrep -f "cursor-remote-control/(feishu|dingtalk|wecom)" > /dev/null 2>&1; then
        echo "manual"
        return
    fi
    
    echo "none"
}

# ========== launchd 模式函数 ==========

install_launchd() {
    echo "📦 安装为系统服务（launchd）..."
    echo ""
    
    # 检查每个子项目的 service.sh
    local installed=0
    
    for dir in feishu dingtalk wecom; do
        if [ -f "$PROJECT_ROOT/$dir/service.sh" ]; then
            echo "  安装 $dir 服务..."
            cd "$PROJECT_ROOT/$dir"
            bash service.sh install
            installed=$((installed + 1))
        else
            echo "  ⚠️  $dir/service.sh 不存在，跳过"
        fi
    done
    
    echo ""
    if [ $installed -gt 0 ]; then
        echo "✅ 成功安装 $installed 个服务"
        echo ""
        echo "特性："
        echo "  ✅ 开机自动启动"
        echo "  ✅ 崩溃自动重启"
        echo "  ✅ 系统级守护"
        echo ""
        echo "查看状态: bash manage-services.sh status"
    else
        echo "❌ 未找到任何可安装的服务"
        exit 1
    fi
}

uninstall_launchd() {
    echo "🗑️  卸载系统服务..."
    echo ""
    
    # 先停止所有服务
    stop_launchd
    
    # 删除 plist 文件
    for service in "${SERVICES[@]}"; do
        if [ -f "$PLIST_DIR/$service.plist" ]; then
            echo "  删除 $PLIST_DIR/$service.plist"
            rm -f "$PLIST_DIR/$service.plist"
        fi
    done
    
    echo ""
    echo "✅ 系统服务已卸载"
}

start_launchd() {
    echo "🚀 启动 launchd 服务..."
    
    for service in "${SERVICES[@]}"; do
        if [ -f "$PLIST_DIR/$service.plist" ]; then
            echo "  加载 $service..."
            launchctl load "$PLIST_DIR/$service.plist" 2>/dev/null || true
        fi
    done
    
    echo ""
    echo "等待 2 秒验证启动..."
    sleep 2
}

stop_launchd() {
    echo "🛑 停止 launchd 服务..."
    
    for service in "${SERVICES[@]}"; do
        if launchctl list | grep -q "$service"; then
            echo "  卸载 $service..."
            launchctl unload "$PLIST_DIR/$service.plist" 2>/dev/null || true
        fi
    done
    
    # 给进程 2 秒时间优雅退出
    sleep 2
    
    # 强制清理残留进程
    ps aux | grep -E "bun run.*/(dingtalk|feishu|wecom)/" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null || true
    ps aux | grep -E "caffeinate.*/(dingtalk|feishu|wecom)/" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null || true
    
    echo "  ✅ 所有服务已停止"
}

# ========== 简单模式函数 ==========

start_manual() {
    echo "🚀 启动所有服务（简单模式）..."
    
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
    echo ""
    echo "💡 提示：简单模式不支持开机自启和崩溃重启"
    echo "   如需这些特性，请使用: bash manage-services.sh install"
}

stop_manual() {
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

# ========== 智能函数（自动检测模式）==========

smart_start() {
    local mode=$(detect_mode)
    
    if [ "$mode" = "launchd" ] || is_launchd_installed; then
        start_launchd
    else
        start_manual
    fi
}

smart_stop() {
    local mode=$(detect_mode)
    
    if [ "$mode" = "launchd" ]; then
        stop_launchd
    else
        stop_manual
    fi
}

smart_restart() {
    echo "🔄 重启所有服务..."
    echo ""
    
    smart_stop
    echo ""
    echo "等待 3 秒..."
    sleep 3
    smart_start
    echo ""
    show_status
}

# ========== 状态显示 ==========

show_status() {
    local mode=$(detect_mode)
    
    echo "📊 服务状态"
    echo ""
    echo "【运行模式】"
    
    if [ "$mode" = "launchd" ]; then
        echo "  🟢 launchd 系统服务（开机自启、崩溃重启）"
        echo ""
        echo "【launchd 状态】"
        for service in "${SERVICES[@]}"; do
            if launchctl list | grep -q "$service"; then
                pid=$(launchctl list | grep "$service" | awk '{print $1}')
                echo "  🟢 $service (PID: $pid)"
            else
                if [ -f "$PLIST_DIR/$service.plist" ]; then
                    echo "  🔴 $service (已安装但未运行)"
                fi
            fi
        done
    elif [ "$mode" = "manual" ]; then
        echo "  🟡 手动启动模式（nohup）"
        echo "  💡 提示：使用 'bash manage-services.sh install' 升级为系统服务"
    else
        echo "  ⚪ 未运行"
        if is_launchd_installed; then
            echo "  💡 已安装 launchd 服务但未启动"
        fi
    fi
    
    echo ""
    echo "【进程状态】"
    
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
    echo "【日志文件】"
    echo "  飞书:     tail -f /tmp/feishu-cursor.log"
    echo "  钉钉:     tail -f /tmp/dingtalk-cursor.log"
    echo "  企业微信: tail -f /tmp/wecom-cursor.log"
}

# ========== 清理重复进程 ==========

clean_duplicates() {
    echo "🧹 清理重复进程..."
    echo ""
    
    # 获取所有进程 PID
    all_pids=$(ps aux | grep -E "bun run.*/(dingtalk|feishu|wecom)/" | grep -v grep | awk '{print $2}' | sort)
    
    if [ -z "$all_pids" ]; then
        echo "没有运行中的进程"
        return
    fi
    
    # 获取 launchd 管理的进程 PID
    launchd_pids=""
    for service in "${SERVICES[@]}"; do
        pid=$(launchctl list 2>/dev/null | grep "$service" | awk '{print $1}')
        if [ "$pid" != "-" ] && [ -n "$pid" ]; then
            launchd_pids="$launchd_pids $pid"
        fi
    done
    
    if [ -n "$launchd_pids" ]; then
        echo "launchd 管理的进程: $launchd_pids"
        echo "所有进程: $all_pids"
        echo ""
        
        # 杀死非 launchd 管理的进程
        killed=0
        for pid in $all_pids; do
            if ! echo "$launchd_pids" | grep -q "$pid"; then
                echo "  清理非托管进程: $pid"
                kill -9 "$pid" 2>/dev/null || true
                killed=$((killed + 1))
            fi
        done
        
        if [ $killed -eq 0 ]; then
            echo "  ✅ 没有重复进程"
        else
            echo ""
            echo "  ✅ 清理了 $killed 个重复进程"
        fi
    else
        echo "当前为手动启动模式，无法判断哪些进程是重复的"
        echo "建议："
        echo "  1. 停止所有进程: bash manage-services.sh stop"
        echo "  2. 安装系统服务: bash manage-services.sh install"
    fi
    
    echo ""
    show_status
}

# ========== 日志查看 ==========

show_logs() {
    local service=$1
    
    case "$service" in
        feishu)
            tail -f /tmp/feishu-cursor.log
            ;;
        dingtalk)
            tail -f /tmp/dingtalk-cursor.log
            ;;
        wecom)
            tail -f /tmp/wecom-cursor.log
            ;;
        *)
            echo "❌ 未知服务: $service"
            echo ""
            echo "可用服务: feishu, dingtalk, wecom"
            exit 1
            ;;
    esac
}

# ========== 帮助信息 ==========

show_help() {
    echo "Cursor Remote Control 服务管理（增强版）"
    echo ""
    echo "用法: bash manage-services.sh <命令> [参数]"
    echo ""
    echo "基础命令:"
    echo "  status              查看服务状态"
    echo "  start               启动所有服务（智能检测模式）"
    echo "  stop                停止所有服务"
    echo "  restart             重启所有服务"
    echo ""
    echo "系统服务（launchd）:"
    echo "  install             安装为系统服务（开机自启、崩溃重启）"
    echo "  uninstall           卸载系统服务"
    echo ""
    echo "维护命令:"
    echo "  clean               清理重复进程"
    echo "  logs <service>      查看日志（feishu/dingtalk/wecom）"
    echo ""
    echo "示例:"
    echo "  bash manage-services.sh status          # 查看状态"
    echo "  bash manage-services.sh install         # 安装为系统服务"
    echo "  bash manage-services.sh restart         # 重启服务"
    echo "  bash manage-services.sh logs feishu     # 查看飞书日志"
    echo ""
    echo "💡 提示:"
    echo "  - 首次使用建议执行 'install' 安装为系统服务"
    echo "  - 系统服务支持开机自启和崩溃自动重启"
    echo "  - 'start/stop/restart' 会自动检测并使用合适的模式"
}

# ========== 主逻辑 ==========

case "${1:-}" in
    status)
        show_status
        ;;
    start)
        smart_start
        echo ""
        show_status
        ;;
    stop)
        smart_stop
        ;;
    restart)
        smart_restart
        ;;
    install)
        install_launchd
        ;;
    uninstall)
        uninstall_launchd
        ;;
    clean)
        clean_duplicates
        ;;
    logs)
        if [ -z "$2" ]; then
            echo "❌ 请指定服务名称"
            echo ""
            echo "用法: bash manage-services.sh logs <service>"
            echo "可用服务: feishu, dingtalk, wecom"
            exit 1
        fi
        show_logs "$2"
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        show_help
        ;;
esac
