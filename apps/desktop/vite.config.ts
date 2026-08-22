import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Tauri 前端构建：开发起 1420 端口（tauri.conf.json devUrl 对应），产物输出 dist（frontendDist=../dist）。
// 组D 加载优化：manualChunks 把 vendor 拆为独立 chunk，首屏只加载当前 view 依赖的包，
// react/react-dom、framer-motion、sonner、highlight.js 等大依赖各成一块，提升缓存命中与首屏速度。
//
// 用函数式 manualChunks（而非对象式）：对象式在 react 被入口同步 import 时会生成空 chunk
// （Rollup 把它留在入口 chunk 里），函数式按 node_modules 路径归组可避免空 chunk 并自动跳过未命中组。
function manualChunks(id: string): string | undefined {
  // 仅对 node_modules 内的依赖分包，业务代码（src/**）走默认分块（含 lazy 边界）。
  if (!id.includes('node_modules')) return undefined;
  // 动画引擎：framer-motion 独立分包（体积大、动画依赖）。
  if (id.includes('framer-motion') || id.includes('/motion-dom') || id.includes('/motion-utils'))
    return 'motion-vendor';
  // markdown 渲染 + 代码高亮：体积可观，仅在渲染 markdown 时需要。
  if (
    id.includes('react-markdown') ||
    id.includes('rehype-highlight') ||
    id.includes('remark-gfm') ||
    id.includes('highlight.js')
  )
    return 'markdown-vendor';
  // toast 反馈：sonner，跨页通用。
  if (id.includes('sonner')) return 'toast-vendor';
  // 图标库：lucide-react。
  if (id.includes('lucide-react')) return 'icons-vendor';
  // AI 创建器：Vercel AI SDK / OpenAI provider 只在打开创建器时需要，避免进入首屏 chunk。
  if (id.includes('/ai/') || id.includes('/@ai-sdk/')) return 'ai-vendor';
  // React 运行时：react / react-dom / scheduler（react-dom 依赖）单独成块（长期缓存）。
  if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/'))
    return 'react-vendor';
  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  define: {
    // 构建期注入本次打包时间（ISO），供「关于」页展示构建时间；dev 模式下为 dev server 启动时刻。
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: { port: 1420, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 调试用：开启 sourcemap，以便把运行时 TDZ「Cannot access 'k' before initialization」
    // 里的压缩名 k 映射回源码位置（dev 模式 Vite 直供源码不压缩，不会触发此问题，
    // 仅生产构建产物 .exe 会复现）。定位完成后可改回 false 再发布。
    sourcemap: true,
    rollupOptions: {
      output: { manualChunks },
    },
  },
});
