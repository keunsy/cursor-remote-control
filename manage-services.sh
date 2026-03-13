#!/bin/bash

# 飞书和钉钉服务管理脚本

# 获取脚本所在目录的绝对路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FEISHU_DIR="${SCRIPT_DIR}/feishu"
DINGTALK_DIR="${SCRIPT_DIR}/dingtalk"

case "$1" in
  start)
    case "$2" in
      feishu)
        echo "🚀 启动飞书服务..."
        cd "$FEISHU_DIR" && nohup bun run start-with-keepawake.ts > /tmp/feishu-cursor.log 2>&1 &
        echo "  ✅ 飞书服务已启动 (PID: $!)"
        ;;
      dingtalk)
        echo "🚀 启动钉钉服务..."
        cd "$DINGTALK_DIR" && nohup bun run start-with-keepawake.ts > /tmp/dingtalk-cursor.log 2>&1 &
        echo "  ✅ 钉钉服务已启动 (PID: $!)"
        ;;
      *)
        echo "🚀 启动所有服务..."
        cd "$FEISHU_DIR" && nohup bun run start-with-keepawake.ts > /tmp/feishu-cursor.log 2>&1 &
        echo "  ✅ 飞书服务已启动 (PID: $!)"
        cd "$DINGTALK_DIR" && nohup bun run start-with-keepawake.ts > /tmp/dingtalk-cursor.log 2>&1 &
        echo "  ✅ 钉钉服务已启动 (PID: $!)"
        ;;
    esac
    ;;
    
  stop)
    case "$2" in
      feishu)
        echo "🛑 停止飞书服务..."
        # 通过工作目录匹配飞书服务进程
        ps aux | grep "bun.*start-with-keepawake" | grep "$FEISHU_DIR" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null
        pkill -9 -f "caffeinate.*feishu" 2>/dev/null
        sleep 1
        echo "  ✅ 飞书服务已停止"
        ;;
      dingtalk)
        echo "🛑 停止钉钉服务..."
        # 通过工作目录匹配钉钉服务进程
        ps aux | grep "bun.*start-with-keepawake" | grep "$DINGTALK_DIR" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null
        pkill -9 -f "caffeinate.*dingtalk" 2>/dev/null
        sleep 1
        echo "  ✅ 钉钉服务已停止"
        ;;
      *)
        echo "🛑 停止所有服务..."
        
        # 清理所有相关进程（start-with-keepawake.ts 和 start.ts）
        pkill -9 -f "bun.*cursor-remote-control.*feishu" 2>/dev/null
        pkill -9 -f "bun.*cursor-remote-control.*dingtalk" 2>/dev/null
        pkill -9 -f "caffeinate.*feishu" 2>/dev/null
        pkill -9 -f "caffeinate.*dingtalk" 2>/dev/null
        
        # 等待进程完全退出
        sleep 1
        
        # 验证是否还有残留进程
        REMAINING=$(ps aux | grep -E "bun.*(feishu|dingtalk)" | grep "cursor-remote-control" | grep -v grep | wc -l)
        if [ "$REMAINING" -gt 0 ]; then
          echo "  ⚠️  发现残留进程，再次清理..."
          ps aux | grep -E "bun.*(feishu|dingtalk)" | grep "cursor-remote-control" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null
          sleep 1
        fi
        
        echo "  ✅ 所有服务已停止"
        ;;
    esac
    ;;
    
  restart)
    case "$2" in
      feishu)
        echo "🔄 重启飞书服务..."
        bash "$0" stop feishu
        sleep 2
        bash "$0" start feishu
        ;;
      dingtalk)
        echo "🔄 重启钉钉服务..."
        bash "$0" stop dingtalk
        sleep 2
        bash "$0" start dingtalk
        ;;
      *)
        echo "🔄 重启所有服务..."
        bash "$0" stop
        sleep 2
        bash "$0" start
        ;;
    esac
    ;;
    
  status)
    echo "📊 服务状态:"
    echo ""
    # 只统计 bun 进程，不包括 caffeinate
    PROCESSES=$(ps aux | grep "bun.*cursor-remote-control" | grep -E "feishu|dingtalk" | grep -v grep | grep -v caffeinate)
    COUNT=$(echo "$PROCESSES" | grep -c "bun" || echo "0")
    
    if [ "$COUNT" -ge 2 ]; then
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
    echo "用法: bash manage-services.sh {start|stop|restart|status|logs} [feishu|dingtalk]"
    echo ""
    echo "命令:"
    echo "  start [service]   - 启动服务"
    echo "    start           - 启动所有服务（飞书 + 钉钉）"
    echo "    start feishu    - 只启动飞书服务"
    echo "    start dingtalk  - 只启动钉钉服务"
    echo ""
    echo "  stop [service]    - 停止服务"
    echo "    stop            - 停止所有服务"
    echo "    stop feishu     - 只停止飞书服务"
    echo "    stop dingtalk   - 只停止钉钉服务"
    echo ""
    echo "  restart [service] - 重启服务"
    echo "    restart         - 重启所有服务"
    echo "    restart feishu  - 只重启飞书服务"
    echo "    restart dingtalk- 只重启钉钉服务"
    echo ""
    echo "  status            - 查看服务状态"
    echo "  logs [service]    - 查看日志"
    echo "    logs feishu     - 查看飞书日志"
    echo "    logs dingtalk   - 查看钉钉日志"
    exit 1
    ;;
esac
