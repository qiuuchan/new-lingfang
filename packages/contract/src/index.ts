// LingFang 平台契约：单一事实来源（见 docs/02 领域模型）。
// 服务端（NestJS apps/collab-api）按相同字段实现；插件 SDK 复用这些类型。契约漂移即视为缺陷。
// （原注释误指「Rust 后端」，apps/server Rust 已删除，跨运行时对齐职责已迁移到 NestJS apps/collab-api——
//  CONTRACT-09 修复）
export * from './identity';
export * from './admin-common';
export * from './plugin';
export * from './plugin-action';
export * from './plugin-workflow';
export * from './plugin-cloud-automation';
export * from './plugin-registry';
export * from './plugin-shared-state';
export * from './draft';
export * from './llm';
export * from './local-scheduler';
