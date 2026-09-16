/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 纯文档放行分类单测（CVW §4.3 补充）
 *
 * 覆盖：
 * - isDocumentationFile 保守分类（扩展名 / 文档名 / .txt 白名单）
 * - 关键防误伤边界：requirements.txt / CMakeLists.txt / license.ts 不得判为文档
 * - isDocOnlyChange 集合语义（空集 false / 全文档 true / 混合 false）
 */

import { describe, it, expect } from 'vitest';
import {
  isDocumentationFile,
  isDocOnlyChange,
} from '../../src/core/verification/index.js';

describe('isDocumentationFile · 纯文档扩展名', () => {
  it.each([
    'README.md',
    'docs/design.md',
    'docs/plans/f1-c1-interactive-multimodal.md',
    'notes.markdown',
    'guide.mdx',
    'spec.rst',
    'manual.adoc',
    'C:/ws/docs/design.md',
    'docs\\sub\\note.rst',
  ])('%s → true', (p) => {
    expect(isDocumentationFile(p)).toBe(true);
  });
});

describe('isDocumentationFile · 文档名（含 LICENSE.txt 白名单）', () => {
  it.each([
    'LICENSE',
    'license',
    'CHANGELOG',
    'CHANGELOG.md',
    'LICENSE.txt',
    'CHANGELOG.txt',
    'docs/AUTHORS',
    'NOTICE',
  ])('%s → true', (p) => {
    expect(isDocumentationFile(p)).toBe(true);
  });
});

describe('isDocumentationFile · 防误伤边界（必须 false）', () => {
  it.each([
    'requirements.txt',
    'CMakeLists.txt',
    'notes.txt',
    'src/license.ts',
    'license.ts',
    'package.json',
    '.github/workflows/ci.yml',
    'scripts/build.sh',
    'assets/logo.svg',
    'src/core/verification/gate.ts',
    'docs/data.md.json',
  ])('%s → false', (p) => {
    expect(isDocumentationFile(p)).toBe(false);
  });
});

describe('isDocOnlyChange · 集合语义', () => {
  it('空集 → false（无编辑走零开销路径，不属于本判定）', () => {
    expect(isDocOnlyChange([])).toBe(false);
  });

  it('全部为纯文档 → true', () => {
    expect(
      isDocOnlyChange(['README.md', '/ws/docs/design.md', '/ws/LICENSE']),
    ).toBe(true);
  });

  it('混合变更（任一非文档）→ false，维持原有门行为', () => {
    expect(isDocOnlyChange(['README.md', 'src/foo.ts'])).toBe(false);
  });

  it('单个代码文件 → false', () => {
    expect(isDocOnlyChange(['src/foo.ts'])).toBe(false);
  });

  it('requirements.txt 单独变更 → false', () => {
    expect(isDocOnlyChange(['requirements.txt'])).toBe(false);
  });
});
