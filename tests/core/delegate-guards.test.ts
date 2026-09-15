/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 子代理只读守卫单测（C · 自动拒绝、不弹审批）
 *
 * 覆盖：
 * - 写工作区命令命中（重定向 / 就地编辑 / 文件系统改写 / git 写 / 包管理器 / 删除）
 * - 只读与验证类命令放行（测试 / 构建 / 类型检查 / git status|log|diff / 读取）
 * - 引号内容不误报
 * - 重定向豁免（2>&1 / >/dev/null）
 * - 路径白名单（目录前缀 vs 精确文件）
 * - 域名白名单（含子域后缀匹配）
 */

import { describe, it, expect } from 'vitest';
import {
  findWorkspaceMutationReason,
  isDelegatePathAllowed,
  isDelegateHostAllowed,
} from '../../src/core/subagent/delegate-guards.js';

describe('findWorkspaceMutationReason · 写工作区命中', () => {
  it('重定向 / 就地编辑 / 截断', () => {
    expect(findWorkspaceMutationReason('echo hi > src/a.ts')).toBeDefined();
    expect(findWorkspaceMutationReason('echo hi >> notes.md')).toBeDefined();
    expect(findWorkspaceMutationReason('sed -i "s/a/b/" src/a.ts')).toBeDefined();
    expect(findWorkspaceMutationReason('perl -pi -e "s/a/b/" f.ts')).toBeDefined();
    expect(findWorkspaceMutationReason('truncate -s 0 a.ts')).toBeDefined();
    expect(findWorkspaceMutationReason('dd of=out.bin if=/dev/zero')).toBeDefined();
    expect(findWorkspaceMutationReason('echo x | tee out.txt')).toBeDefined();
  });

  it('文件系统改写', () => {
    expect(findWorkspaceMutationReason('rm src/a.ts')).toBeDefined();
    expect(findWorkspaceMutationReason('mv a.ts b.ts')).toBeDefined();
    expect(findWorkspaceMutationReason('cp a.ts b.ts')).toBeDefined();
    expect(findWorkspaceMutationReason('touch new.ts')).toBeDefined();
    expect(findWorkspaceMutationReason('mkdir -p src/x')).toBeDefined();
    expect(findWorkspaceMutationReason('chmod +x run.sh')).toBeDefined();
    expect(findWorkspaceMutationReason('patch -p1 < fix.diff')).toBeDefined();
  });

  it('git 写操作', () => {
    expect(findWorkspaceMutationReason('git checkout -- src/')).toBeDefined();
    expect(findWorkspaceMutationReason('git add -A')).toBeDefined();
    expect(findWorkspaceMutationReason('git commit -m "x"')).toBeDefined();
    expect(findWorkspaceMutationReason('git reset --hard HEAD~1')).toBeDefined();
    expect(findWorkspaceMutationReason('git clean -fd')).toBeDefined();
    expect(findWorkspaceMutationReason('git stash')).toBeDefined();
    expect(findWorkspaceMutationReason('git apply fix.patch')).toBeDefined();
    expect(findWorkspaceMutationReason('git push origin main')).toBeDefined();
  });

  it('包管理器安装 / 依赖变更', () => {
    expect(findWorkspaceMutationReason('npm install')).toBeDefined();
    expect(findWorkspaceMutationReason('pnpm add lodash')).toBeDefined();
    expect(findWorkspaceMutationReason('yarn remove react')).toBeDefined();
    expect(findWorkspaceMutationReason('pip install requests')).toBeDefined();
    expect(findWorkspaceMutationReason('cargo add serde')).toBeDefined();
  });
});

describe('findWorkspaceMutationReason · 只读 / 验证类放行', () => {
  it('测试 / 构建 / 类型检查 / 诊断命令自动放行', () => {
    const allow = [
      'npm test',
      'npm run build',
      'npm run type-check',
      'npx vitest run tests/core',
      'npx tsc --noEmit',
      'pytest -q',
      'go test ./...',
      'ls -la src',
      'cat package.json',
      'grep -rn "TODO" src/',
      'git status',
      'git log --oneline -5',
      'git diff HEAD~1',
      'node --version',
      'node -e "console.log(1)"',
    ];
    for (const c of allow) {
      expect(findWorkspaceMutationReason(c), `should allow: ${c}`).toBeUndefined();
    }
  });

  it('引号内内容不误报', () => {
    expect(findWorkspaceMutationReason('grep -rn "cp" src/')).toBeUndefined();
    expect(findWorkspaceMutationReason("grep -rn 'rm ' src/")).toBeUndefined();
    expect(findWorkspaceMutationReason('echo "a > b"')).toBeUndefined();
  });

  it('重定向豁免：2>&1 / >/dev/null 放行，写文件拦截', () => {
    expect(findWorkspaceMutationReason('npm test 2>&1')).toBeUndefined();
    expect(findWorkspaceMutationReason('npm test > /dev/null')).toBeUndefined();
    expect(findWorkspaceMutationReason('npm test > out.log')).toBeDefined();
  });
});

describe('isDelegatePathAllowed · 子代理路径白名单', () => {
  const guidePrefixes = ['.devseeker/', 'docs/', 'AGENTS.md'];

  it('目录前缀匹配', () => {
    expect(isDelegatePathAllowed('docs/plans/a.md', guidePrefixes)).toBe(true);
    expect(isDelegatePathAllowed('.devseeker/config.json', guidePrefixes)).toBe(true);
    expect(isDelegatePathAllowed('src/core/loop.ts', guidePrefixes)).toBe(false);
  });

  it('精确文件匹配（AGENTS.md）', () => {
    expect(isDelegatePathAllowed('AGENTS.md', guidePrefixes)).toBe(true);
    expect(isDelegatePathAllowed('AGENTS.md.bak', guidePrefixes)).toBe(false);
    expect(isDelegatePathAllowed('sub/AGENTS.md', guidePrefixes)).toBe(false);
  });

  it('Windows 反斜杠归一', () => {
    expect(isDelegatePathAllowed('docs\\plans\\a.md', guidePrefixes)).toBe(true);
  });
});

describe('isDelegateHostAllowed · 子代理域名白名单', () => {
  const whitelist = ['vitest.dev', 'code.visualstudio.com'];

  it('精确 host 与子域后缀匹配', () => {
    expect(isDelegateHostAllowed('https://vitest.dev/api/', whitelist)).toBe(true);
    expect(isDelegateHostAllowed('https://docs.vitest.dev/x', whitelist)).toBe(true);
    expect(isDelegateHostAllowed('https://code.visualstudio.com/docs', whitelist)).toBe(true);
  });

  it('非白名单 / 恶意后缀拒绝', () => {
    expect(isDelegateHostAllowed('https://evil.com/vitest.dev', whitelist)).toBe(false);
    expect(isDelegateHostAllowed('https://notvitest.dev/', whitelist)).toBe(false);
    expect(isDelegateHostAllowed('not-a-url', whitelist)).toBe(false);
  });
});
