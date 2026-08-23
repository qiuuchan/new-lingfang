// relaySettings.spec.ts — F5：relay 凭据纯校验的单测。
import { describe, expect, it } from 'vitest';
import { relayTokenHint, validateRelayApiBase } from './relaySettings';

describe('validateRelayApiBase', () => {
  it('空串（清除配置）与纯空白合法', () => {
    expect(validateRelayApiBase('')).toBeNull();
    expect(validateRelayApiBase('   ')).toBeNull();
  });

  it('合法 https URL 通过（含 trim 与带路径）', () => {
    expect(validateRelayApiBase('https://relay.example.com')).toBeNull();
    expect(validateRelayApiBase('  https://relay.example.com/v1  ')).toBeNull();
  });

  it('非 URL 与非 https 拒绝并给出可读文案', () => {
    expect(validateRelayApiBase('relay.example.com')).toMatch(/合法 URL/);
    expect(validateRelayApiBase('http://relay.example.com')).toMatch(/https/);
    expect(validateRelayApiBase('ftp://relay.example.com')).toMatch(/https/);
  });
});

describe('relayTokenHint', () => {
  it('空与无空白不提示', () => {
    expect(relayTokenHint('')).toBeNull();
    expect(relayTokenHint('sk-normal-token-123')).toBeNull();
  });

  it('含空白字符给出非阻断提示', () => {
    expect(relayTokenHint('abc def')).toMatch(/空白/);
    expect(relayTokenHint('abc\ndef')).toMatch(/空白/);
  });
});
