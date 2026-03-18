#!/bin/bash

# 飞书、钉钉、企业微信服务管理脚本

# 获取脚本所在目录的绝对路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FEISHU_DIR="${SCRIPT_DIR}/feishu"
DINGTALK_DIR="${SCRIPT_DIR}/dingtalk"
WECOM_DIR="${SCRIPT_DIR}/wecom"

# PID 文件路径
FEISHU_PID="/tmp/feishu-cursor.pid"
DINGTALK_PID="/tmp/dingtalk-cursor.pid"
WECOM_PID="/tmp/wecom-cursor.pid"

case "$1" in
  start)
    case "$2" in
      feishu)
        echo "🚀 启动飞书服务..."
        cd "$FEISHU_DIR" && nohup bun run start-with-keepawake.ts > /tmp/feishu-cursor.log 2>&1 &
        FEISHU_MAIN_PID=$!
        echo "$FEISHU_MAIN_PID" > "$FEISHU_PID"
        echo "  ✅ 飞书服务已启动 (PID: $FEISHU_MAIN_PID, 已记录到 $FEISHU_PID)"
        ;;
      dingtalk)
        echo "🚀 启动钉钉服务..."
        cd "$DINGTALK_DIR" && nohup bun run start-with-keepawake.ts > /tmp/dingtalk-cursor.log 2>&1 &
        DINGTALK_MAIN_PID=$!
        echo "$DINGTALK_MAIN_PID" > "$DINGTALK_PID"
        echo "  ✅ 钉钉服务已启动 (PID: $DINGTALK_MAIN_PID, 已记录到 $DINGTALK_PID)"
        ;;
      wecom)
        echo "🚀 启动企业微信服务..."
        cd "$WECOM_DIR" && nohup bun run start-with-keepawake.ts > /tmp/wecom-cursor.log 2>&1 &
        WECOM_MAIN_PID=$!
        echo "$WECOM_MAIN_PID" > "$WECOM_PID"
        echo "  ✅ 企业微信服务已启动 (PID: $WECOM_MAIN_PID, 已记录到 $WECOM_PID)"
        ;;
      *)
        echo "🚀 启动所有服务..."
        cd "$FEISHU_DIR" && nohup bun run start-with-keepawake.ts > /tmp/feishu-cursor.log 2>&1 &
        FEISHU_MAIN_PID=$!
        echo "$FEISHU_MAIN_PID" > "$FEISHU_PID"
        echo "  ✅ 飞书服务已启动 (PID: $FEISHU_MAIN_PID)"
        cd "$DINGTALK_DIR" && nohup bun run start-with-keepawake.ts > /tmp/dingtalk-cursor.log 2>&1 &
        DINGTALK_MAIN_PID=$!
        echo "$DINGTALK_MAIN_PID" > "$DINGTALK_PID"
        echo "  ✅ 钉钉服务已启动 (PID: $DINGTALK_MAIN_PID)"
        cd "$WECOM_DIR" && nohup bun run start-with-keepawake.ts > /tmp/wecom-cursor.log 2>&1 &
        WECOM_MAIN_PID=$!
        echo "$WECOM_MAIN_PID" > "$WECOM_PID"
        echo "  ✅ 企业微信服务已启动 (PID: $WECOM_MAIN_PID)"
        ;;
    esac
    ;;
    
  stop)
    case "$2" in
      feishu)
        echo "🛑 停止飞书服务..."
        
        # 方案1：优先使用 PID 文件（精确杀进程）
        if [ -f "$FEISHU_PID" ]; then
          MAIN_PID=$(cat "$FEISHU_PID")
          echo "  📌 从 PID 文件读取主进程: $MAIN_PID"
          
          # 杀主进程及其子进程树
          pkill -9 -P "$MAIN_PID" 2>/dev/null
          kill -9 "$MAIN_PID" 2>/dev/null
          rm -f "$FEISHU_PID"
        fi
        
        # 方案2：兜底清理（处理历史残留或 PID 文件丢失的情况）
        pkill -9 -f "bun.*cursor-remote-control.*feishu" 2>/dev/null
        pkill -9 -f "caffeinate.*feishu" 2>/dev/null
        
        sleep 1
        echo "  ✅ 飞书服务已停止"
        ;;
      dingtalk)
        echo "🛑 停止钉钉服务..."
        
        # 方案1：优先使用 PID 文件
        if [ -f "$DINGTALK_PID" ]; then
          MAIN_PID=$(cat "$DINGTALK_PID")
          echo "  📌 从 PID 文件读取主进程: $MAIN_PID"
          
          pkill -9 -P "$MAIN_PID" 2>/dev/null
          kill -9 "$MAIN_PID" 2>/dev/null
          rm -f "$DINGTALK_PID"
        fi
        
        # 方案2：兜底清理
        pkill -9 -f "bun.*cursor-remote-control.*dingtalk" 2>/dev/null
        pkill -9 -f "caffeinate.*dingtalk" 2>/dev/null
        
        sleep 1
        echo "  ✅ 钉钉服务已停止"
        ;;
      wecom)
        echo "🛑 停止企业微信服务..."
        
        # 方案1：优先使用 PID 文件
        if [ -f "$WECOM_PID" ]; then
          MAIN_PID=$(cat "$WECOM_PID")
          echo "  📌 从 PID 文件读取主进程: $MAIN_PID"
          
          pkill -9 -P "$MAIN_PID" 2>/dev/null
          kill -9 "$MAIN_PID" 2>/dev/null
          rm -f "$WECOM_PID"
        fi
        
        # 方案2：兜底清理
        pkill -9 -f "bun.*cursor-remote-control.*wecom" 2>/dev/null
        pkill -9 -f "caffeinate.*wecom" 2>/dev/null
        
        sleep 1
        echo "  ✅ 企业微信服务已停止"
        ;;
      *)
        echo "🛑 停止所有服务..."
        
        # 方案1：PID 文件精确清理
        KILLED=0
        if [ -f "$FEISHU_PID" ]; then
          MAIN_PID=$(cat "$FEISHU_PID")
          echo "  📌 飞书主进程: $MAIN_PID"
          pkill -9 -P "$MAIN_PID" 2>/dev/null
          kill -9 "$MAIN_PID" 2>/dev/null
          rm -f "$FEISHU_PID"
          KILLED=1
        fi
        
        if [ -f "$DINGTALK_PID" ]; then
          MAIN_PID=$(cat "$DINGTALK_PID")
          echo "  📌 钉钉主进程: $MAIN_PID"
          pkill -9 -P "$MAIN_PID" 2>/dev/null
          kill -9 "$MAIN_PID" 2>/dev/null
          rm -f "$DINGTALK_PID"
          KILLED=1
        fi
        
        if [ -f "$WECOM_PID" ]; then
          MAIN_PID=$(cat "$WECOM_PID")
          echo "  📌 企业微信主进程: $MAIN_PID"
          pkill -9 -P "$MAIN_PID" 2>/dev/null
          kill -9 "$MAIN_PID" 2>/dev/null
          rm -f "$WECOM_PID"
          KILLED=1
        fi
        
        # 方案2：兜底清理（清理历史残留或 PID 文件丢失的进程）
        if [ "$KILLED" -eq 0 ]; then
          echo "  ⚠️  PID 文件不存在，使用兜底清理模式..."
        fi
        
        pkill -9 -f "bun.*cursor-remote-control.*feishu" 2>/dev/null
        pkill -9 -f "bun.*cursor-remote-control.*dingtalk" 2>/dev/null
        pkill -9 -f "bun.*cursor-remote-control.*wecom" 2>/dev/null
        pkill -9 -f "caffeinate.*feishu" 2>/dev/null
        pkill -9 -f "caffeinate.*dingtalk" 2>/dev/null
        pkill -9 -f "caffeinate.*wecom" 2>/dev/null
        
        sleep 1
        
        # 方案3：最终扫描，确保没有漏网之鱼
        REMAINING=$(ps aux | grep -E "bun.*cursor-remote-control" | grep -E "feishu|dingtalk|wecom" | grep -v grep | wc -l)
        if [ "$REMAINING" -gt 0 ]; then
          echo "  ⚠️  发现残留进程 ($REMAINING 个)，再次清理..."
          ps aux | grep -E "bun.*cursor-remote-control" | grep -E "feishu|dingtalk|wecom" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null
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
      wecom)
        echo "🔄 重启企业微信服务..."
        bash "$0" stop wecom
        sleep 2
        bash "$0" start wecom
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
    PROCESSES=$(ps aux | grep "bun.*cursor-remote-control" | grep -E "feishu|dingtalk|wecom" | grep -v grep | grep -v caffeinate)
    COUNT=$(echo "$PROCESSES" | grep -c "bun" || echo "0")
    
    if [ "$COUNT" -ge 3 ]; then
      echo "  🟢 飞书、钉钉、企业微信服务都在运行"
      echo ""
      echo "$PROCESSES" | awk '{print "  PID: " $2 " | 运行时间: " $10 " | CPU: " $3 "% | 内存: " $4 "%"}'
    elif [ "$COUNT" -ge 1 ]; then
      echo "  ⚠️  只有 $COUNT 个服务在运行"
      echo "$PROCESSES" | awk '{print "  PID: " $2 " | 运行时间: " $10}'
    else
      echo "  ⚪ 服务未运行"
    fi
    
    echo ""
    echo "📝 日志文件:"
    echo "  飞书: /tmp/feishu-cursor.log"
    echo "  钉钉: /tmp/dingtalk-cursor.log"
    echo "  企业微信: /tmp/wecom-cursor.log"
    ;;
    
  logs)
    case "$2" in
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
        echo "📝 查看日志:"
        echo "  飞书: bash manage-services.sh logs feishu"
        echo "  钉钉: bash manage-services.sh logs dingtalk"
        echo "  企业微信: bash manage-services.sh logs wecom"
        ;;
    esac
    ;;
    
  *)
    echo "Cursor Remote Control - 服务管理"
    echo ""
    echo "用法: bash manage-services.sh {start|stop|restart|status|logs} [feishu|dingtalk|wecom]"
    echo ""
    echo "命令:"
    echo "  start [service]   - 启动服务"
    echo "    start           - 启动所有服务（飞书 + 钉钉 + 企业微信）"
    echo "    start feishu    - 只启动飞书服务"
    echo "    start dingtalk  - 只启动钉钉服务"
    echo "    start wecom     - 只启动企业微信服务"
    echo ""
    echo "  stop [service]    - 停止服务"
    echo "    stop            - 停止所有服务"
    echo "    stop feishu     - 只停止飞书服务"
    echo "    stop dingtalk   - 只停止钉钉服务"
    echo "    stop wecom      - 只停止企业微信服务"
    echo ""
    echo "  restart [service] - 重启服务"
    echo "    restart         - 重启所有服务"
    echo "    restart feishu  - 只重启飞书服务"
    echo "    restart dingtalk- 只重启钉钉服务"
    echo "    restart wecom   - 只重启企业微信服务"
    echo ""
    echo "  status            - 查看服务状态"
    echo "  logs [service]    - 查看日志"
    echo "    logs feishu     - 查看飞书日志"
    echo "    logs dingtalk   - 查看钉钉日志"
    echo "    logs wecom      - 查看企业微信日志"
    exit 1
    ;;
esac
