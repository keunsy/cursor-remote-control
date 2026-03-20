#!/bin/bash
# IM 平台服务统一管理脚本
# 用法: ./service-management.sh [status|restart|stop|clean]

set -e

PLIST_DIR="$HOME/Library/LaunchAgents"
SERVICES=(
    "com.cursor-feishu"
    "com.dingtalk-cursor-claw"
    "com.wecom-cursor-claw"
)

# 显示服务状态
status() {
    echo "=== launchd 服务状态 ==="
    for service in "${SERVICES[@]}"; do
        echo "[$service]"
        launchctl list | grep "$service" || echo "  未运行"
    done
    echo ""
    echo "=== 进程列表 ==="
    ps aux | grep -E "bun run.*/(dingtalk|feishu|wecom)/" | grep -v grep || echo "无运行进程"
    echo ""
    echo "=== 进程统计 ==="
    count=$(ps aux | grep -E "bun run.*/(dingtalk|feishu|wecom)/" | grep -v grep | wc -l | xargs)
    echo "当前运行进程数: $count (正常应该是 6 个)"
}

# 完全停止所有服务
stop() {
    echo "=== 停止 launchd 服务 ==="
    for service in "${SERVICES[@]}"; do
        echo "卸载 $service..."
        launchctl unload "$PLIST_DIR/$service.plist" 2>/dev/null || true
    done
    
    echo ""
    echo "=== 清理残留进程 ==="
    # 给进程 2 秒时间优雅退出
    sleep 2
    
    # 强制杀死所有残留进程
    ps aux | grep -E "bun run.*/(dingtalk|feishu|wecom)/" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null || true
    ps aux | grep -E "caffeinate.*/(dingtalk|feishu|wecom)/" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null || true
    
    echo "所有服务已停止"
}

# 重启所有服务
restart() {
    echo "=== 重启服务 ==="
    stop
    echo ""
    echo "等待 3 秒..."
    sleep 3
    
    echo "=== 启动 launchd 服务 ==="
    for service in "${SERVICES[@]}"; do
        echo "加载 $service..."
        launchctl load "$PLIST_DIR/$service.plist"
    done
    
    echo ""
    echo "等待 2 秒验证启动..."
    sleep 2
    status
}

# 清理重复进程（保留 launchd 管理的）
clean() {
    echo "=== 清理重复进程 ==="
    
    # 获取所有进程 PID
    all_pids=$(ps aux | grep -E "bun run.*/(dingtalk|feishu|wecom)/" | grep -v grep | awk '{print $2}' | sort)
    
    if [ -z "$all_pids" ]; then
        echo "没有运行中的进程"
        return
    fi
    
    # 获取 launchd 管理的进程 PID
    launchd_pids=""
    for service in "${SERVICES[@]}"; do
        pid=$(launchctl list | grep "$service" | awk '{print $1}')
        if [ "$pid" != "-" ] && [ -n "$pid" ]; then
            launchd_pids="$launchd_pids $pid"
        fi
    done
    
    echo "launchd 管理的进程: $launchd_pids"
    echo "所有进程: $all_pids"
    echo ""
    
    # 杀死非 launchd 管理的进程
    for pid in $all_pids; do
        if ! echo "$launchd_pids" | grep -q "$pid"; then
            echo "清理非托管进程: $pid"
            kill -9 "$pid" 2>/dev/null || true
        fi
    done
    
    echo ""
    status
}

# 主逻辑
case "${1:-status}" in
    status)
        status
        ;;
    restart)
        restart
        ;;
    stop)
        stop
        ;;
    clean)
        clean
        ;;
    *)
        echo "用法: $0 [status|restart|stop|clean]"
        echo ""
        echo "  status  - 显示服务状态"
        echo "  restart - 重启所有服务"
        echo "  stop    - 停止所有服务"
        echo "  clean   - 清理重复进程（保留 launchd 管理的）"
        exit 1
        ;;
esac
