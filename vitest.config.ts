import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    // vscode 模块在单测中以 mock 替代
    alias: {
      vscode: new URL('./tests/__mocks__/vscode.ts', import.meta.url).pathname,
    },
  },
});
