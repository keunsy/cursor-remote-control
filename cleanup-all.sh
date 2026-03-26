#!/bin/bash
# 全局进程清理脚本
# 用于清理所有 IM 平台的残留进程和锁文件

set -e

echo "🧹 开始清理所有服务的残留进程..."

# 1. 停止所有 launchd 服务
echo ""
echo "📋 停止 launchd 服务..."
for service in com.cursor-feishu com.dingtalk-cursor-claw com.wecom-cursor-claw com.wechat-cursor-claw; do
	if launchctl print "gui/$(id -u)/$service" &>/dev/null; then
		echo "  停止: $service"
		launchctl kill SIGTERM "gui/$(id -u)/$service" 2>/dev/null || true
	fi
done

# 等待进程退出
echo "  等待进程退出..."
sleep 2

# 2. 清理残留进程（基于进程路径匹配）
echo ""
echo "🔪 清理残留进程..."

declare -a PLATFORMS=("feishu" "dingtalk" "wecom" "wechat" "telegram")
declare -a KILLED_PIDS=()

for platform in "${PLATFORMS[@]}"; do
	# 查找所有相关进程
	PIDS=$(ps aux | grep -E "bun.*${platform}/(server|start)" | grep -v grep | awk '{print $2}' || true)
	
	if [ -n "$PIDS" ]; then
		echo "  发现 $platform 残留进程: $PIDS"
		for pid in $PIDS; do
			kill -TERM $pid 2>/dev/null || true
			KILLED_PIDS+=($pid)
		done
	fi
	
	# 查找 caffeinate 包裹的进程
	CAFFEINE_PIDS=$(ps aux | grep -E "caffeinate.*${platform}" | grep -v grep | awk '{print $2}' || true)
	if [ -n "$CAFFEINE_PIDS" ]; then
		echo "  发现 $platform caffeinate 进程: $CAFFEINE_PIDS"
		for pid in $CAFFEINE_PIDS; do
			kill -TERM $pid 2>/dev/null || true
			KILLED_PIDS+=($pid)
		done
	fi
	
	# 查找 start-with-keepawake 进程
	KEEPAWAKE_PIDS=$(ps aux | grep -E "${platform}/start-with-keepawake" | grep -v grep | awk '{print $2}' || true)
	if [ -n "$KEEPAWAKE_PIDS" ]; then
		echo "  发现 $platform keepawake 进程: $KEEPAWAKE_PIDS"
		for pid in $KEEPAWAKE_PIDS; do
			kill -TERM $pid 2>/dev/null || true
			KILLED_PIDS+=($pid)
		done
	fi
done

if [ ${#KILLED_PIDS[@]} -gt 0 ]; then
	echo "  已终止 ${#KILLED_PIDS[@]} 个进程"
	sleep 1
else
	echo "  ✅ 没有发现残留进程"
fi

# 3. 清理进程锁文件
echo ""
echo "🔐 清理进程锁文件..."
declare -a LOCK_FILES=(
	"/tmp/cursor-feishu.pid"
	"/tmp/cursor-dingtalk.pid"
	"/tmp/cursor-wecom.pid"
	"/tmp/cursor-wechat.pid"
	"/tmp/cursor-telegram.pid"
)

for lockfile in "${LOCK_FILES[@]}"; do
	if [ -f "$lockfile" ]; then
		rm -f "$lockfile"
		echo "  删除: $lockfile"
	fi
done

echo "  ✅ 锁文件已清理"

# 4. 验证清理结果
echo ""
echo "🔍 验证清理结果..."
REMAINING=$(ps aux | grep -E "bun.*(feishu|dingtalk|wecom|wechat|telegram)/(server|start)" | grep -v grep | wc -l || echo 0)

if [ "$REMAINING" -eq 0 ]; then
	echo "  ✅ 所有进程已清理干净"
else
	echo "  ⚠️  仍有 $REMAINING 个进程残留"
	ps aux | grep -E "bun.*(feishu|dingtalk|wecom|wechat|telegram)" | grep -v grep || true
fi

echo ""
echo "✅ 清理完成！"
echo ""
echo "💡 提示："
echo "  - 重新启动所有服务: bash manage-services.sh restart"
echo "  - 重新启动单个服务: cd <platform> && bash service.sh install"
