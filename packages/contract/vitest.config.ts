import { defineConfig } from 'vitest/config';

// include 与其它工作区包统一为 `*.{test,spec}.{ts,tsx,mts,mjs}`，避免各包方言不同
// 导致新测试被静默跳过。exclude 必须显式写全 node_modules/dist/coverage —— 一旦提供
// exclude，vitest 就不再叠加默认值。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx,mts,mjs}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
  },
});
