// Node ESM loader hooks：为 contract 等使用 bundler-style 无扩展 import 的 TS 包
// 自动补全 .ts 扩展。仅本地开发/测试用，不影响构建产物。
//
// 用法：
//   node --import ./packages/plugin-sdk/scripts/loader-hooks.mjs \
//        --experimental-strip-types \
//        packages/plugin-sdk/src/cli/index.ts <args>
//
// 实现：用 Node 22+ register() API 在模块图加载前激活 hooks。

import { register } from 'node:module';

register('./loader-hooks-impl.mjs', import.meta.url);
