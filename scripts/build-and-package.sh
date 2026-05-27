#!/usr/bin/env bash
# build-and-package.sh —— 一次性完成：类型检查 → 单元测试 → 编译 → 打包 VSIX
#
# 用法：
#   ./scripts/build-and-package.sh              # 完整流程
#   ./scripts/build-and-package.sh --quick       # 跳过 type-check + test
#   ./scripts/build-and-package.sh --skip-test   # 跳过 test，保留 type-check
#
# 退出码：0=成功，非0=某一步失败

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$0")/..")"

ROOT=$(pwd)
VSIX_NAME="devseeker-$(node -p "require('./package.json').version").vsix"
SKIP_TC=false
SKIP_TEST=false
for arg in "$@"; do
  case "$arg" in
    --quick) SKIP_TC=true; SKIP_TEST=true ;;
    --skip-test) SKIP_TEST=true ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✅ $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "  ${YELLOW}⚡ $1${NC}"; }

STEP=0

# ─────────── 1. 类型检查 ───────────
if [ "$SKIP_TC" = false ]; then
  STEP=$((STEP+1))
  echo ""
  echo "━━━ Step $STEP: 类型检查（npm run type-check） ━━━"
  if npm run type-check 2>&1; then
    pass "TypeScript 类型检查通过"
  else
    fail "TypeScript 类型检查失败，请修复后重试"
  fi
else
  info "跳过类型检查"
fi

# ─────────── 2. 单元测试 ───────────
if [ "$SKIP_TEST" = false ]; then
  STEP=$((STEP+1))
  echo ""
  echo "━━━ Step $STEP: 单元测试（npm test） ━━━"
  if npm test 2>&1; then
    pass "单元测试全部通过"
  else
    fail "单元测试有失败项，请修复后重试"
  fi
else
  info "跳过单元测试"
fi

# ─────────── 3. 编译 ───────────
STEP=$((STEP+1))
echo ""
echo "━━━ Step $STEP: 编译（npm run build） ━━━"
if npm run build 2>&1; then
  pass "编译成功"
else
  fail "编译失败，请修复后重试"
fi

# ─────────── 4. 打包 VSIX ───────────
STEP=$((STEP+1))
echo ""
echo "━━━ Step $STEP: 打包 VSIX ━━━"
if node scripts/vsce-package.mjs 2>&1; then
  echo ""
  pass "打包成功"
else
  fail "打包失败"
fi

# ─────────── 5. 验证 ───────────
STEP=$((STEP+1))
echo ""
echo "━━━ Step $STEP: 验证产物 ━━━"
VSIX_PATH="$ROOT/$VSIX_NAME"
if [ -f "$VSIX_PATH" ]; then
  SIZE_MB=$(du -h "$VSIX_PATH" | cut -f1)
  FILE_COUNT=$(unzip -l "$VSIX_PATH" 2>/dev/null | tail -1 | awk '{print $2}' || echo "?")
  echo "  产物: $VSIX_NAME"
  echo "  大小: $SIZE_MB"
  echo "  文件: ${FILE_COUNT:-?} 个"
  # 检查是否包含 node_modules（常见遗漏）
  NM_COUNT=$(unzip -l "$VSIX_PATH" 2>/dev/null | grep -c "node_modules" || true)
  if [ "$NM_COUNT" -gt 0 ]; then
    pass "node_modules/ 已包含（$NM_COUNT 个文件）"
  else
    fail "node_modules/ 未包含在 VSIX 中！打包可能不完整"
  fi
  # 检查是否包含 models/ 下的 onnx 模型
  ONNX_COUNT=$(unzip -l "$VSIX_PATH" 2>/dev/null | grep -c "\.onnx$" || true)
  if [ "$ONNX_COUNT" -gt 0 ]; then
    pass "模型权重文件已包含（$ONNX_COUNT 个）"
  else
    info "模型权重文件未包含（如使用在线嵌入则正常）"
  fi
else
  fail "VSIX 文件 $VSIX_NAME 未生成"
fi

# ─────────── 完成 ───────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ 全部完成！${NC}"
echo "   包名: $VSIX_NAME"
echo "   路径: $VSIX_PATH"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
