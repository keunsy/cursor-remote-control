#!/bin/bash

# 飞书和钉钉服务管理脚本

# 获取脚本所在目录的绝对路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FEISHU_DIR="${SCRIPT_DIR}/feishu"
DINGTALK_DIR="${SCRIPT_DIR}/dingtalk"

case "$1" in
  start)
    echo "🚀 启动服务..."
    cd "$FEISHU_DIR" && nohup bun run start-with-keepawake.ts > /tmp/feishu-cursor.log 2>&1 &
    echo "  ✅ 飞书服务已启动 (PID: $!)"
    cd "$DINGTALK_DIR" && nohup bun run start-with-keepawake.ts > /tmp/dingtalk-cursor.log 2>&1 &
    echo "  ✅ 钉钉服务已启动 (PID: $!)"
    ;;
    
  stop)
    echo "🛑 停止服务..."
    
    # 清理所有飞书相关进程（更彻底的匹配）
    pkill -9 -f "bun.*feishu" 2>/dev/null
    pkill -9 -f "caffeinate.*feishu" 2>/dev/null
    
    # 清理所有钉钉相关进程
    pkill -9 -f "bun.*dingtalk" 2>/dev/null
    pkill -9 -f "caffeinate.*dingtalk" 2>/dev/null
    
    # 等待进程完全退出
    sleep 1
    
    # 验证是否还有残留进程
    REMAINING=$(ps aux | grep -E "bun.*(feishu|dingtalk)" | grep -v grep | wc -l)
    if [ "$REMAINING" -gt 0 ]; then
      echo "  ⚠️  发现残留进程，再次清理..."
      ps aux | grep -E "bun.*(feishu|dingtalk)" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null
      sleep 1
    fi
    
    echo "  ✅ 所有服务已停止"
    ;;
    
  restart)
    echo "🔄 重启服务..."
    "$0" stop
    sleep 2
    "$0" start
    ;;
    
  status)
    echo "📊 服务状态:"
    echo ""
    PROCESSES=$(ps aux | grep "bun.*start-with-keepawake" | grep -v grep)
    COUNT=$(echo "$PROCESSES" | grep -c "bun")
    
    if [ "$COUNT" -eq 2 ]; then
      echo "  🟢 飞书和钉钉服务都在运行"
      echo ""
      echo "$PROCESSES" | awk '{print "  PID: " $2 " | 运行时间: " $10 " | CPU: " $3 "% | 内存: " $4 "%"}'
    elif [ "$COUNT" -eq 1 ]; then
      echo "  ⚠️  只有一个服务在运行"
      echo "$PROCESSES" | awk '{print "  PID: " $2 " | 运行时间: " $10}'
    else
      echo "  ⚪ 服务未运行"
    fi
    
    echo ""
    echo "📝 日志文件:"
    echo "  飞书: /tmp/feishu-cursor.log"
    echo "  钉钉: /tmp/dingtalk-cursor.log"
    ;;
    
  logs)
    case "$2" in
      feishu)
        tail -f /tmp/feishu-cursor.log
        ;;
      dingtalk)
        tail -f /tmp/dingtalk-cursor.log
        ;;
      *)
        echo "📝 查看日志:"
        echo "  飞书: bash manage-services.sh logs feishu"
        echo "  钉钉: bash manage-services.sh logs dingtalk"
        ;;
    esac
    ;;
    
  *)
    echo "Cursor Remote Control - 服务管理"
    echo ""
    echo "用法: bash manage-services.sh {start|stop|restart|status|logs}"
    echo ""
    echo "命令:"
    echo "  start    - 启动飞书和钉钉服务"
    echo "  stop     - 停止所有服务"
    echo "  restart  - 重启所有服务"
    echo "  status   - 查看服务状态"
    echo "  logs     - 查看日志 (logs feishu | logs dingtalk)"
    exit 1
    ;;
esac
