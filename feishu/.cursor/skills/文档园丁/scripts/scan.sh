#!/bin/bash
# 文档园丁 — 自动扫描脚本
# 用法: bash scan.sh <项目根目录>

PROJECT_ROOT="${1:-.}"
DOCS_DIR="$PROJECT_ROOT/文档"
AGENTS_FILE="$PROJECT_ROOT/AGENTS.md"
ARCH_FILE="$PROJECT_ROOT/架构.md"
ENV_FILE="$PROJECT_ROOT/.env"
CRED_FILE="$DOCS_DIR/凭据与配置/开发环境凭据总览.md"
QUALITY_FILE="$DOCS_DIR/质量评分/模块质量评分.md"

ERRORS=0
WARNINGS=0

echo "======================================"
echo "  文档园丁 — 自动巡检"
echo "  项目: $PROJECT_ROOT"
echo "  时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "======================================"
echo ""

# ============================================================
# 第一部分：文档结构检查
# ============================================================

# === 检查1: 关键文件存在性 ===
echo "[检查1] 关键文件存在性"
for f in "$AGENTS_FILE" "$ARCH_FILE" "$DOCS_DIR"; do
    if [ -e "$f" ]; then
        echo "  ✓ $(basename "$f")"
    else
        echo "  ✗ 缺失: $(basename "$f")"
        ERRORS=$((ERRORS + 1))
    fi
done
echo ""

# === 检查2: AGENTS.md 行数 ===
echo "[检查2] AGENTS.md 行数"
if [ -f "$AGENTS_FILE" ]; then
    AGENTS_LINES=$(wc -l < "$AGENTS_FILE")
    if [ "$AGENTS_LINES" -le 250 ]; then
        echo "  ✓ ${AGENTS_LINES} 行（限制250行）"
    else
        echo "  ✗ ${AGENTS_LINES} 行，超过250行限制！"
        ERRORS=$((ERRORS + 1))
    fi
fi
echo ""

# === 检查3: 设计文档验证状态头部 ===
echo "[检查3] 设计文档验证状态头部"
if [ -d "$DOCS_DIR/设计文档" ]; then
    DESIGN_TOTAL=0
    MISSING_HEADER=0
    for file in "$DOCS_DIR/设计文档"/*.md; do
        [ -f "$file" ] || continue
        DESIGN_TOTAL=$((DESIGN_TOTAL + 1))
        if ! head -5 "$file" | grep -q "验证状态"; then
            echo "  ⚠ 缺失验证状态: $(basename "$file")"
            MISSING_HEADER=$((MISSING_HEADER + 1))
            WARNINGS=$((WARNINGS + 1))
        fi
    done
    if [ "$MISSING_HEADER" -eq 0 ] && [ "$DESIGN_TOTAL" -gt 0 ]; then
        echo "  ✓ 全部 ${DESIGN_TOTAL} 份设计文档均有验证状态"
    elif [ "$MISSING_HEADER" -gt 0 ]; then
        echo "  共 ${MISSING_HEADER}/${DESIGN_TOTAL} 份缺失验证状态"
    fi
fi
echo ""

# === 检查4: AGENTS.md 索引同步 ===
echo "[检查4] AGENTS.md 索引同步"
if [ -f "$AGENTS_FILE" ] && [ -d "$DOCS_DIR" ]; then
    SYNC_OK=true
    for subdir in "$DOCS_DIR"/*/; do
        [ -d "$subdir" ] || continue
        dirname=$(basename "$subdir")
        if ! grep -q "$dirname" "$AGENTS_FILE"; then
            echo "  ⚠ AGENTS.md 未索引: 文档/$dirname/"
            WARNINGS=$((WARNINGS + 1))
            SYNC_OK=false
        fi
    done
    $SYNC_OK && echo "  ✓ AGENTS.md 索引与文档目录同步"
fi
echo ""

# === 检查5: 超30天未更新 ===
echo "[检查5] 超30天未更新的文档"
STALE_COUNT=0
THIRTY_DAYS_AGO=$(date -d '30 days ago' +%s 2>/dev/null || echo "0")
if [ "$THIRTY_DAYS_AGO" != "0" ] && [ -d "$DOCS_DIR" ]; then
    while IFS= read -r file; do
        FILE_MTIME=$(stat -c %Y "$file" 2>/dev/null || echo "0")
        if [ "$FILE_MTIME" -lt "$THIRTY_DAYS_AGO" ] && [ "$FILE_MTIME" != "0" ]; then
            DAYS_OLD=$(( ($(date +%s) - FILE_MTIME) / 86400 ))
            REL_PATH=$(echo "$file" | sed "s|$PROJECT_ROOT/||")
            echo "  ⚠ ${DAYS_OLD}天未更新: $REL_PATH"
            STALE_COUNT=$((STALE_COUNT + 1))
            WARNINGS=$((WARNINGS + 1))
        fi
    done < <(find "$DOCS_DIR" -name "*.md" -type f)
    [ "$STALE_COUNT" -eq 0 ] && echo "  ✓ 全部文档均在30天内更新"
fi
echo ""

# === 检查6: 空目录 ===
echo "[检查6] 空目录"
EMPTY_COUNT=0
if [ -d "$DOCS_DIR" ]; then
    while IFS= read -r dir; do
        if [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
            echo "  ⚠ 空目录: $(echo "$dir" | sed "s|$PROJECT_ROOT/||")"
            EMPTY_COUNT=$((EMPTY_COUNT + 1))
            WARNINGS=$((WARNINGS + 1))
        fi
    done < <(find "$DOCS_DIR" -type d -mindepth 1)
    [ "$EMPTY_COUNT" -eq 0 ] && echo "  ✓ 无空目录"
fi
echo ""

# ============================================================
# 第二部分：代码-文档一致性检查
# ============================================================

echo "============================================"
echo "  代码-文档一致性检查"
echo "============================================"
echo ""

# === 检查7: 容器一致性（架构.md vs docker ps）===
echo "[检查7] 容器一致性（架构.md vs 实际运行）"
if [ -f "$ARCH_FILE" ] && command -v docker &>/dev/null; then
    docker ps --format "{{.Names}}" 2>/dev/null | sort > /tmp/dg_actual_containers.txt
    # 从架构.md 部署拓扑表格提取容器名（只匹配容器表区域内的行）
    sed -n '/容器名.*端口映射/,/^$/p' "$ARCH_FILE" | grep -oP '^\| ([a-z][a-z0-9_-]+)' | sed 's/| //' | sort -u > /tmp/dg_doc_containers.txt

    # 实际有但文档没记录的
    MISSING_IN_DOC=$(comm -23 /tmp/dg_actual_containers.txt /tmp/dg_doc_containers.txt)
    if [ -n "$MISSING_IN_DOC" ]; then
        echo "  ✗ 实际运行但架构.md未记录:"
        echo "$MISSING_IN_DOC" | while read -r c; do
            PORTS=$(docker port "$c" 2>/dev/null | head -3 | tr '\n' ', ' | sed 's/,$//')
            echo "    - $c  ($PORTS)"
        done
        ERRORS=$((ERRORS + $(echo "$MISSING_IN_DOC" | wc -l)))
    fi

    # 文档有但实际没运行的
    MISSING_IN_ACTUAL=$(comm -13 /tmp/dg_actual_containers.txt /tmp/dg_doc_containers.txt)
    if [ -n "$MISSING_IN_ACTUAL" ]; then
        echo "  ⚠ 架构.md记录但未运行:"
        echo "$MISSING_IN_ACTUAL" | while read -r c; do echo "    - $c"; done
        WARNINGS=$((WARNINGS + $(echo "$MISSING_IN_ACTUAL" | wc -l)))
    fi

    if [ -z "$MISSING_IN_DOC" ] && [ -z "$MISSING_IN_ACTUAL" ]; then
        DOC_COUNT=$(wc -l < /tmp/dg_doc_containers.txt)
        ACTUAL_COUNT=$(wc -l < /tmp/dg_actual_containers.txt)
        echo "  ✓ 架构.md ($DOC_COUNT) 与实际运行 ($ACTUAL_COUNT) 容器一致"
    fi
    rm -f /tmp/dg_actual_containers.txt /tmp/dg_doc_containers.txt
else
    echo "  跳过（架构.md不存在或docker不可用）"
fi
echo ""

# === 检查8: 端口映射一致性 ===
echo "[检查8] 端口映射一致性"
if [ -f "$ARCH_FILE" ] && command -v docker &>/dev/null; then
    PORT_MISMATCH=0
    # 检查几个核心容器的端口
    while IFS= read -r container; do
        [ -z "$container" ] && continue
        ACTUAL_PORT=$(docker port "$container" 2>/dev/null | head -1 | grep -oP '\d+$')
        if [ -n "$ACTUAL_PORT" ]; then
            if ! grep -q "$ACTUAL_PORT" "$ARCH_FILE" 2>/dev/null; then
                echo "  ⚠ $container 实际端口 $ACTUAL_PORT 未出现在架构.md"
                PORT_MISMATCH=$((PORT_MISMATCH + 1))
                WARNINGS=$((WARNINGS + 1))
            fi
        fi
    done < <(docker ps --format '{{.Names}}' 2>/dev/null)
    [ "$PORT_MISMATCH" -eq 0 ] && echo "  ✓ 核心容器端口映射与架构.md一致"
fi
echo ""

# === 检查9: .env 与凭据文档一致性 ===
echo "[检查9] .env 与凭据文档一致性"
if [ -f "$ENV_FILE" ] && [ -f "$CRED_FILE" ]; then
    ENV_MISSING=0
    # 提取 .env 中的变量名和值，检查是否在凭据文档中有记录
    # 凭据文档用中文描述（如"root密码"），所以同时检查变量名和实际值
    ENV_MISSING_VARS=""
    while IFS='=' read -r key value; do
        [ -z "$key" ] && continue
        [[ "$key" == \#* ]] && continue
        [[ "$key" == *" "* ]] && continue
        # 检查变量名或值是否出现在凭据文档中
        if ! grep -qF "$key" "$CRED_FILE" 2>/dev/null && ! grep -qF "$value" "$CRED_FILE" 2>/dev/null; then
            ENV_MISSING_VARS="$ENV_MISSING_VARS $key"
        fi
    done < "$ENV_FILE"
    MISSING_COUNT=$(echo "$ENV_MISSING_VARS" | wc -w)
    if [ "$MISSING_COUNT" -gt 0 ]; then
        echo "  ⚠ ${MISSING_COUNT} 个 .env 变量未出现在凭据文档（变量名和值均未匹配）:"
        for v in $ENV_MISSING_VARS; do
            echo "    - $v"
        done
        WARNINGS=$((WARNINGS + 1))
    else
        echo "  ✓ .env 所有变量均在凭据文档中记录"
    fi
else
    [ ! -f "$ENV_FILE" ] && echo "  跳过（.env 不存在）"
    [ ! -f "$CRED_FILE" ] && echo "  跳过（凭据文档不存在）"
fi
echo ""

# === 检查10: 模块目录一致性 ===
echo "[检查10] 模块目录一致性（架构.md vs 实际目录）"
if [ -f "$ARCH_FILE" ]; then
    # 从架构.md 代码包结构中提取中文模块目录名
    MODULE_MISMATCH=0
    while IFS= read -r dir; do
        module_dir=$(basename "$dir")
        if ! grep -q "$module_dir" "$ARCH_FILE" 2>/dev/null; then
            echo "  ⚠ 目录存在但架构.md未提到: $module_dir/"
            MODULE_MISMATCH=$((MODULE_MISMATCH + 1))
            WARNINGS=$((WARNINGS + 1))
        fi
    done < <(find "$PROJECT_ROOT" -maxdepth 1 -type d -not -name '.*' -not -name 'node_modules' -not -name 'dist' -not -name 'build' -not -name '__pycache__' | sort)
    # 检查实际存在的模块目录是否在架构.md中提到（含 docker-compose）
    for dir in "$PROJECT_ROOT"/*/; do
        dirname=$(basename "$dir")
        # 跳过通用非模块目录
        case "$dirname" in
            node_modules|.git|dist|build|__pycache__) continue ;;
        esac
        if [ -f "$dir/docker-compose.yml" ] || [ -f "$dir/docker-compose.yaml" ]; then
            if ! grep -q "$dirname" "$ARCH_FILE" 2>/dev/null; then
                echo "  ⚠ 有docker-compose但架构.md未提到: $dirname/"
                MODULE_MISMATCH=$((MODULE_MISMATCH + 1))
                WARNINGS=$((WARNINGS + 1))
            fi
        fi
    done
    [ "$MODULE_MISMATCH" -eq 0 ] && echo "  ✓ 模块目录与架构.md一致"
fi
echo ""

# === 检查11: 部署模式一致性 ===
echo "[检查11] 部署模式一致性（docker-compose vs 架构.md）"
if [ -f "$ARCH_FILE" ]; then
    MODE_MISMATCH=0
    for module_dir in "$PROJECT_ROOT"/*/; do
        [ -d "$module_dir" ] || continue
        COMPOSE_FILE="$module_dir/docker-compose.yml"
        [ -f "$COMPOSE_FILE" ] || continue
        dirname=$(basename "$module_dir")

        # 检查是否有 --reload（开发模式标志），用 grep -l 避免多行匹配问题
        HAS_RELOAD=0
        grep -q "\-\-reload" "$COMPOSE_FILE" 2>/dev/null && HAS_RELOAD=1
        # 检查架构.md 中记录的模式
        if grep -q "$dirname.*开发" "$ARCH_FILE" 2>/dev/null; then
            DOC_MODE="开发"
        elif grep -q "$dirname.*生产" "$ARCH_FILE" 2>/dev/null; then
            DOC_MODE="生产"
        else
            continue
        fi

        if [ "$HAS_RELOAD" -gt 0 ] && [ "$DOC_MODE" = "生产" ]; then
            echo "  ⚠ $dirname: 架构.md标记为生产，但docker-compose含--reload"
            MODE_MISMATCH=$((MODE_MISMATCH + 1))
            WARNINGS=$((WARNINGS + 1))
        elif [ "$HAS_RELOAD" -eq 0 ] && [ "$DOC_MODE" = "开发" ]; then
            echo "  ⚠ $dirname: 架构.md标记为开发，但docker-compose无--reload"
            MODE_MISMATCH=$((MODE_MISMATCH + 1))
            WARNINGS=$((WARNINGS + 1))
        fi
    done
    [ "$MODE_MISMATCH" -eq 0 ] && echo "  ✓ 部署模式与架构.md标记一致"
fi
echo ""

# ============================================================
# 第三部分：Git 变更分析
# ============================================================

echo "============================================"
echo "  Git 变更分析"
echo "============================================"
echo ""

# === 检查12: 最近变更但文档未更新的模块 ===
echo "[检查12] 代码变更 vs 文档更新"
if [ -d "$PROJECT_ROOT/.git" ]; then
    cd "$PROJECT_ROOT"

    echo "  最近5次提交:"
    git log --oneline -5 2>/dev/null | while read -r line; do echo "    $line"; done
    echo ""

    # 获取最近一次提交后被修改的代码文件（排除文档和配置）
    LAST_COMMIT_DATE=$(git log -1 --format=%ci 2>/dev/null | cut -d' ' -f1)
    if [ -n "$LAST_COMMIT_DATE" ]; then
        echo "  上次提交: $LAST_COMMIT_DATE"
        echo "  此后修改的代码文件所属模块:"
        # 找出上次提交后修改的文件，提取模块名
        CODE_CHANGED_MODS=$(git diff --name-only HEAD 2>/dev/null | grep -v "^文档/" | grep -v "^备份/" | grep -v "^AGENTS.md" | grep -v "^架构.md" | grep -oP '^[^/]+' | sort -u)
        UNSYNC_COUNT=0
        for mod in $CODE_CHANGED_MODS; do
            DOC_UPDATED=false
            if find "$DOCS_DIR" -name "*${mod}*" -newer "$PROJECT_ROOT/.git/index" -type f 2>/dev/null | grep -q .; then
                DOC_UPDATED=true
            fi
            if $DOC_UPDATED; then
                echo "    ✓ $mod（文档已同步）"
            else
                echo "    ⚠ $mod（代码已改，文档未更新）"
                UNSYNC_COUNT=$((UNSYNC_COUNT + 1))
            fi
        done
        WARNINGS=$((WARNINGS + UNSYNC_COUNT))
    fi
else
    echo "  ⚠ 非 git 仓库，跳过"
fi
echo ""

# === 检查13: 文档统计 ===
echo "[检查13] 文档统计"
if [ -d "$DOCS_DIR" ]; then
    TOTAL_DOCS=$(find "$DOCS_DIR" -name "*.md" -type f | wc -l)
    echo "  文档总数: ${TOTAL_DOCS}"
    for subdir in "$DOCS_DIR"/*/; do
        [ -d "$subdir" ] || continue
        count=$(find "$subdir" -name "*.md" -type f | wc -l)
        dirname=$(basename "$subdir")
        echo "    $dirname: $count 份"
    done
fi
echo ""

# ============================================================
# 汇总
# ============================================================
echo "======================================"
echo "  巡检汇总"
echo "======================================"
echo "  错误: ${ERRORS}"
echo "  警告: ${WARNINGS}"
echo ""

if [ "$ERRORS" -gt 0 ]; then
    echo "❌ 存在必须修复的问题，请 Agent 进一步分析。"
    exit 1
elif [ "$WARNINGS" -gt 0 ]; then
    echo "⚠️ 存在建议修复的问题。"
    exit 0
else
    echo "✅ 文档健康状态良好！"
    exit 0
fi
