import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// 桌面端纯函数单测配置：node 环境 + 复用 vite 的 @ 别名。
// 仅采集 src 下的 *.spec.ts，避免误纳入构建产物。
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx,mts,mjs}'],
  },
});
