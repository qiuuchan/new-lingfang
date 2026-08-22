// errorMessage 单测（DESK-UPDATE-01 修复）：核心覆盖 Tauri 命令的「裸字符串」reject 场景——
// 这是「检查更新失败」只显示通用兜底文案、真实原因被吞的根因。
// 同时覆盖 Error/对象/空值/fallback 各分支，确保归一化稳定。
import { describe, expect, it } from 'vitest';
import { errorMessage } from '@/lib/api';

describe('errorMessage', () => {
  it('裸字符串原样返回（Tauri Result<_, String> reject 形态）', () => {
    // Rust 侧 .map_err(|e| e.to_string()) 抛出的真实错误，此前被 (err as ApiError).message 吞掉。
    expect(errorMessage('ClaudeCode SDK 返回错误：HTTP 401')).toBe(
      'ClaudeCode SDK 返回错误：HTTP 401'
    );
  });

  it('裸字符串去除首尾空白', () => {
    expect(errorMessage('  网络超时  ')).toBe('网络超时');
  });

  it('Error 对象取 message', () => {
    expect(errorMessage(new Error('解析失败'))).toBe('解析失败');
  });

  it('对象形态优先取 message 字段', () => {
    expect(errorMessage({ message: '签名验证失败' })).toBe('签名验证失败');
  });

  it('对象无 message 时取 error 字段', () => {
    expect(errorMessage({ error: 'endpoint 无效' })).toBe('endpoint 无效');
  });

  it('空字符串落到 fallback', () => {
    expect(errorMessage('', '检查更新失败，请重试')).toBe('检查更新失败，请重试');
  });

  it('空白字符串 trim 后为空，落到 fallback', () => {
    expect(errorMessage('   ', '检查更新失败，请重试')).toBe('检查更新失败，请重试');
  });

  it('null/undefined 落到 fallback', () => {
    expect(errorMessage(null, '下载更新失败，请重试')).toBe('下载更新失败，请重试');
    expect(errorMessage(undefined, '下载更新失败，请重试')).toBe('下载更新失败，请重试');
  });

  it('无 fallback 时提取不到返回空串', () => {
    expect(errorMessage(null)).toBe('');
  });

  it('message 为空的 Error 落到 fallback', () => {
    expect(errorMessage(new Error(''), '兜底文案')).toBe('兜底文案');
  });
});
