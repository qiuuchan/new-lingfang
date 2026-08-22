import { test, expect } from 'vitest';
import {
  TierSchema,
  ChatRelayInputSchema,
  ImageRelayInputSchema,
  injectSystemGuardRule,
  DEFAULT_AI_USAGE_GUARD_RULE,
  LlmCallLogSchema,
  RelayModelsResponseSchema,
} from './billing.ts';

// 需求 #3：系统提示词规则注入必须在所有路径生效，且不破坏既有 system 内容。
test('injectSystemGuardRule prepends a system message when none exists', () => {
  const out = injectSystemGuardRule([{ role: 'user', content: 'hi' }]);
  expect(out[0].role).toBe('system');
  expect(out[0].content).toBe(DEFAULT_AI_USAGE_GUARD_RULE);
  expect(out.length).toBe(2);
  expect(out[1].role).toBe('user');
});

test('injectSystemGuardRule appends a separate system segment when system already present (no mutation of original)', () => {
  const original = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '画一张猫' },
  ];
  const out = injectSystemGuardRule(original);
  expect(out.length).toBe(3);
  expect(out[0].content).toBe('你是助手'); // 原 system 保留
  expect(out[2].role).toBe('system'); // 规则作为独立 system 段追加在末尾
  expect(out[2].content).toBe(DEFAULT_AI_USAGE_GUARD_RULE);
  // 不 mutate 入参
  expect(original.length).toBe(2);
});

test('injectSystemGuardRule is a no-op when rule is blank (允许后台清空规则)', () => {
  const out = injectSystemGuardRule([{ role: 'user', content: 'hi' }], '   ');
  expect(out.length).toBe(1);
});

// 需求 #5：协议层强制两版本——model 只接受 'fast'/'premium' 哨兵。
test('TierSchema accepts only fast/premium', () => {
  expect(TierSchema.safeParse('fast').success).toBe(true);
  expect(TierSchema.safeParse('premium').success).toBe(true);
  expect(TierSchema.safeParse('gpt-4o').success).toBe(false);
  expect(TierSchema.safeParse('').success).toBe(false);
});

test('ChatRelayInputSchema rejects custom model ids (protocol enforces two tiers)', () => {
  const ok = ChatRelayInputSchema.safeParse({
    model: 'fast',
    messages: [{ role: 'user', content: 'hi' }],
  });
  expect(ok.success).toBe(true);
  const bad = ChatRelayInputSchema.safeParse({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
  });
  expect(bad.success).toBe(false);
});

test('relay schemas default an omitted model to fast', () => {
  const parsed = ChatRelayInputSchema.parse({ messages: [{ role: 'user', content: 'hi' }] });
  expect(parsed.model).toBe('fast');
});

test('ImageRelayInputSchema enforces prompt + tier + bounds n', () => {
  expect(ImageRelayInputSchema.safeParse({ model: 'premium', prompt: 'a cat' }).success).toBe(true);
  // n 上限 10
  expect(ImageRelayInputSchema.safeParse({ model: 'premium', prompt: 'x', n: 11 }).success).toBe(
    false
  );
  // 空 prompt 拒绝
  expect(ImageRelayInputSchema.safeParse({ model: 'fast', prompt: '' }).success).toBe(false);
});

test('LlmCallLogSchema exposes client telemetry without an API key relation', () => {
  expect('clientSource' in LlmCallLogSchema.shape).toBe(true);
  expect('apiKeyId' in LlmCallLogSchema.shape).toBe(false);
});

test('RelayModelsResponseSchema accepts the available fast/premium tier subset', () => {
  const parsed = RelayModelsResponseSchema.parse({
    data: [{ id: 'fast' }, { id: 'premium' }],
  });
  expect(parsed.data.length).toBe(2);
});
