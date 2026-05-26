#!/bin/bash
# 为 src/ tests/ 下所有 .ts 文件加 MIT 版权头部（跳过已有 Copyright 的文件）
ROOT="$(dirname "$0")/.."
HEADER='/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */'
cd "$ROOT" || exit 1
find src tests -name '*.ts' -type f | while read f; do
  if head -5 "$f" | grep -qi "copyright"; then continue; fi
  if head -1 "$f" | grep -q "^#!"; then continue; fi
  [ -s "$f" ] || continue
  tmp=$(mktemp)
  printf '%s\n\n' "$HEADER" > "$tmp"
  cat "$f" >> "$tmp"
  mv "$tmp" "$f"
  echo "  [add] $f"
done
echo "done"
