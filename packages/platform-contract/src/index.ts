// 平台云专属契约：桌面壳（apps/desktop）与插件 SDK（@lingfang/plugin-sdk）不消费这些形状，
// 它们由平台云（NestJS apps/collab-api）实现。已从 @lingfang/contract 拆出（LF-09 / H1），
// 让桌面开发的「单一权威来源」不再拖拽用不到的形状。
// 共享基元（plugin / plugin-registry / semver / plugin-action 等）仍来自 @lingfang/contract。
export * from './marketplace-discovery.ts';
export * from './marketplace-commerce.ts';
export * from './plugin-governance.ts';
export * from './web-plugin-center.ts';
export * from './admin-governance.ts';
export * from './rbac.ts';
export * from './billing.ts';
