/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CVW 测试框架探测器单测（docs/verification-workflow-optimization-plan.md §4.1）
 *
 * 用真实临时目录验证：探测器的输入只是"文件存在性 + 内容正则"，
 * mock fs 反而会掩盖路径拼接错误。
 *
 * 覆盖：
 * - npm（vitest / jest / 仅 test script）/ pytest / go / cargo / cmake / make / CI 兜底
 * - 交叉工具链识别（嵌入式 → 降级链 L3）
 * - conventions 采样（目录、命名模式、import 风格）
 * - 缓存与失败降级
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectTestPlan, clearTestPlanCache } from '../../src/core/verification/index.js';

let root: string;

beforeEach(async () => {
  clearTestPlanCache();
  root = await fs.mkdtemp(join(tmpdir(), 'devseeker-cvw-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

describe('detectTestPlan · npm 生态', () => {
  it('vitest：框架直调命令 + 类型检查 + 构建', async () => {
    await write('package.json', JSON.stringify({
      devDependencies: { vitest: '^1.6.0', typescript: '^5.4.0' },
      scripts: { test: 'vitest run', 'type-check': 'tsc --noEmit', build: 'node esbuild.mjs' },
    }));
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.framework).toBe('vitest');
    // 直调而非 npm test：便于追加文件参数收敛到最小测试集
    expect(plan.testCommand).toBe('npx vitest run');
    expect(plan.typecheckCommand).toBe('npm run type-check');
    expect(plan.buildCommand).toBe('npm run build');
  });

  it('jest 优先级低于 vitest', async () => {
    await write('package.json', JSON.stringify({
      devDependencies: { vitest: '^1.0.0', jest: '^29.0.0' },
    }));
    expect((await detectTestPlan(root, { noCache: true })).framework).toBe('vitest');
  });

  it('jest：npx jest', async () => {
    await write('package.json', JSON.stringify({ devDependencies: { jest: '^29.0.0' } }));
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.framework).toBe('jest');
    expect(plan.testCommand).toBe('npx jest');
  });

  it('mocha', async () => {
    await write('package.json', JSON.stringify({ devDependencies: { mocha: '^10.0.0' } }));
    expect((await detectTestPlan(root, { noCache: true })).testCommand).toBe('npx mocha');
  });

  it('无框架依赖但有 test script → 遵循项目命令，框架标 none', async () => {
    await write('package.json', JSON.stringify({ scripts: { test: './run-tests.sh' } }));
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.framework).toBe('none');
    expect(plan.testCommand).toBe('npm test');
  });

  it('typescript 依赖但无 type-check script → 回落 npx tsc --noEmit', async () => {
    await write('package.json', JSON.stringify({
      devDependencies: { vitest: '^1.0.0', typescript: '^5.0.0' },
    }));
    expect((await detectTestPlan(root, { noCache: true })).typecheckCommand).toBe('npx tsc --noEmit');
  });

  it('package.json 非法 JSON → 继续往后探测（不抛异常）', async () => {
    await write('package.json', '{ broken');
    await write('go.mod', 'module example.com/x\n');
    expect((await detectTestPlan(root, { noCache: true })).framework).toBe('go');
  });
});

describe('detectTestPlan · 其它生态', () => {
  it('pytest（pytest.ini）', async () => {
    await write('pytest.ini', '[pytest]\n');
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.framework).toBe('pytest');
    expect(plan.testCommand).toBe('python -m pytest');
    expect(plan.typecheckCommand).toBeUndefined();
  });

  it('pytest（pyproject.toml + mypy）', async () => {
    await write('pyproject.toml', '[tool.poetry.dev-dependencies]\npytest = "^8.0"\nmypy = "^1.0"\n');
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.framework).toBe('pytest');
    expect(plan.typecheckCommand).toBe('python -m mypy .');
  });

  it('pytest（requirements.txt）', async () => {
    await write('requirements.txt', 'pytest==8.1.1\n');
    expect((await detectTestPlan(root, { noCache: true })).framework).toBe('pytest');
  });

  it('go', async () => {
    await write('go.mod', 'module example.com/x\n');
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.framework).toBe('go');
    expect(plan.testCommand).toBe('go test ./...');
    expect(plan.buildCommand).toBe('go build ./...');
  });

  it('cargo', async () => {
    await write('Cargo.toml', '[package]\nname = "x"\n');
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.framework).toBe('cargo');
    expect(plan.testCommand).toBe('cargo test');
    expect(plan.typecheckCommand).toBe('cargo check');
  });

  it('cmake + enable_testing → ctest', async () => {
    await write('CMakeLists.txt', 'project(x)\nenable_testing()\n');
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.framework).toBe('ctest');
    expect(plan.testCommand).toBe('ctest --output-on-failure');
    expect(plan.crossToolchain).toBeUndefined();
  });

  it('cmake 无 enable_testing → 只有构建命令', async () => {
    await write('CMakeLists.txt', 'project(x)\n');
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.framework).toBe('none');
    expect(plan.testCommand).toBe('');
    expect(plan.buildCommand).toBe('cmake --build build');
  });

  it('Makefile 有 test 目标', async () => {
    await write('Makefile', 'build:\n\tgcc a.c\ntest:\n\t./a.out\n');
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.framework).toBe('make');
    expect(plan.testCommand).toBe('make test');
    expect(plan.buildCommand).toBe('make build');
  });

  it('Makefile 无 test 目标 → 不认作 make 框架', async () => {
    await write('Makefile', 'all:\n\tgcc a.c\n');
    expect((await detectTestPlan(root, { noCache: true })).framework).toBe('none');
  });

  it('CI 工作流兜底提取测试命令', async () => {
    await write('.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: npm run test:ci\n');
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.framework).toBe('none');
    expect(plan.testCommand).toBe('npm run test:ci');
  });
});

describe('detectTestPlan · 交叉工具链（嵌入式）', () => {
  it('CMake 工具链文件 → crossToolchain，不认作可运行测试', async () => {
    await write('CMakeLists.txt', 'set(CMAKE_TOOLCHAIN_FILE arm.cmake)\nenable_testing()\n');
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.crossToolchain).toBe(true);
    expect(plan.framework).toBe('none');
    expect(plan.testCommand).toBe('');
    expect(plan.buildCommand).toBe('cmake --build build');
  });

  it('arm-none-eabi 工具链前缀', async () => {
    await write('CMakeLists.txt', 'set(CMAKE_C_COMPILER arm-none-eabi-gcc)\n');
    expect((await detectTestPlan(root, { noCache: true })).crossToolchain).toBe(true);
  });

  it('Makefile 中的 avr-gcc', async () => {
    await write('Makefile', 'CC=avr-gcc\ntest:\n\techo x\n');
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.framework).toBe('make');
    expect(plan.crossToolchain).toBe(true);
  });
});

describe('detectTestPlan · conventions 采样', () => {
  it('从现有测试文件提取目录、命名模式与 import 风格', async () => {
    await write('package.json', JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }));
    await write('tests/core/loop.test.ts', [
      "import { describe, it } from 'vitest';",
      "import { TaskLoop } from '../../src/core/task/loop.js';",
      '',
      'describe("x", () => {});',
    ].join('\n'));
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.conventions.testDir).toBe('tests/core');
    expect(plan.conventions.filePattern).toBe('*.test.ts');
    expect(plan.conventions.importStyle).toContain("from 'vitest'");
  });

  it('无测试文件时回落默认约定', async () => {
    await write('package.json', JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }));
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.conventions.testDir).toBe('tests');
    expect(plan.conventions.filePattern).toBe('*.test.ts');
    expect(plan.conventions.importStyle).toBeUndefined();
  });

  it('pytest 前缀命名模式', async () => {
    await write('pytest.ini', '[pytest]\n');
    await write('tests/test_util.py', 'import pytest\n\ndef test_x():\n    pass\n');
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.conventions.testDir).toBe('tests');
    expect(plan.conventions.filePattern).toBe('test_*.py');
  });

  it('跳过 node_modules 等噪声目录', async () => {
    await write('package.json', JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }));
    await write('node_modules/pkg/x.test.ts', 'import "x";\n');
    await write('src/app.test.ts', 'import "y";\n');
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.conventions.testDir).toBe('src');
  });
});

describe('detectTestPlan · 缓存与降级', () => {
  it('空目录 → framework=none（交由降级链 L4 兜底）', async () => {
    const plan = await detectTestPlan(root, { noCache: true });
    expect(plan.framework).toBe('none');
    expect(plan.testCommand).toBe('');
    expect(plan.buildCommand).toBeUndefined();
  });

  it('workspaceRoot 缺失 → none', async () => {
    expect((await detectTestPlan(undefined)).framework).toBe('none');
  });

  it('默认走缓存：二次探测不受文件后续变化影响', async () => {
    await write('go.mod', 'module example.com/x\n');
    expect((await detectTestPlan(root)).framework).toBe('go');
    await fs.rm(join(root, 'go.mod'));
    expect((await detectTestPlan(root)).framework).toBe('go');
    clearTestPlanCache();
    expect((await detectTestPlan(root)).framework).toBe('none');
  });

  it('noCache 不污染缓存', async () => {
    await write('go.mod', 'module example.com/x\n');
    await detectTestPlan(root, { noCache: true });
    await fs.rm(join(root, 'go.mod'));
    expect((await detectTestPlan(root)).framework).toBe('none');
  });
});
