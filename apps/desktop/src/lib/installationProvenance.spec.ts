// installationProvenance.spec.ts — F3：来源徽标与签名状态展示逻辑的单测。
import { describe, expect, it } from 'vitest';
import {
  installationOriginBadge,
  signatureStatusLabel,
  type PluginSignatureStatus,
} from './installationProvenance';

describe('installationOriginBadge', () => {
  it('builtin 不出徽标（由「受保护」覆盖）', () => {
    expect(installationOriginBadge('builtin')).toBeNull();
  });

  it('local 琥珀色「本地导入」', () => {
    const badge = installationOriginBadge('local');
    expect(badge?.label).toBe('本地导入');
    expect(badge?.tone).toBe('amber');
  });

  it('team / marketplace / dev 中性徽标', () => {
    expect(installationOriginBadge('team')).toEqual({ label: '团队', tone: 'neutral' });
    expect(installationOriginBadge('marketplace')).toEqual({ label: '市场', tone: 'neutral' });
    expect(installationOriginBadge('dev')).toEqual({ label: '开发态', tone: 'neutral' });
  });

  it('未知与缺失 origin 视为可疑来源（琥珀）', () => {
    expect(installationOriginBadge(undefined)?.tone).toBe('amber');
    expect(installationOriginBadge('weird')?.label).toBe('未知来源');
  });
});

describe('signatureStatusLabel', () => {
  const base: PluginSignatureStatus = { signed: true, verified: true, reason: '签名验证通过' };

  it('signed+verified 才算通过', () => {
    expect(signatureStatusLabel(base).ok).toBe(true);
  });

  it('未签名 / 未配置公钥 / 验签失败均为非通过并透传 reason', () => {
    expect(
      signatureStatusLabel({ signed: false, verified: false, reason: '插件未附带签名（manifest.sig 缺失）' }),
    ).toEqual({ text: '插件未附带签名（manifest.sig 缺失）', ok: false });
    expect(
      signatureStatusLabel({ signed: true, verified: false, reason: '平台未配置插件验签公钥' }).ok,
    ).toBe(false);
    expect(signatureStatusLabel({ signed: true, verified: false, reason: '签名验证失败' }).ok).toBe(false);
  });

  it('reason 缺失时给出兜底文案', () => {
    expect(signatureStatusLabel({ signed: false, verified: false, reason: '' }).text).toBe('未签名');
  });
});
