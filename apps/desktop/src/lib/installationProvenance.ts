// installationProvenance.ts — 安装来源徽标与签名状态的纯展示逻辑（IMPROVEMENT_PLAN F3）。
//
// 安装账本（LocalInstallation.origin）是来源的唯一事实：builtin 已有「受保护」徽标覆盖，
// local 是 v1 政策重点关注对象（未签名第三方），用琥珀色提示。
// 签名状态来自 verify_plugin_signature_command：signed+verified 才算通过，
// 其余（未签名/未配置公钥/验签失败）一律非阻断琥珀提示——与 Rust 侧
// 「signed=false 不阻断，仅状态展示」的语义一致。

export interface OriginBadge {
  label: string;
  tone: 'amber' | 'neutral';
}

export function installationOriginBadge(origin?: string): OriginBadge | null {
  switch (origin) {
    case 'builtin':
      return null; // 已由「受保护」徽标覆盖
    case 'local':
      return { label: '本地导入', tone: 'amber' };
    case 'team':
      return { label: '团队', tone: 'neutral' };
    case 'marketplace':
      return { label: '市场', tone: 'neutral' };
    default:
      return { label: '未知来源', tone: 'amber' };
  }
}

export interface PluginSignatureStatus {
  signed: boolean;
  verified: boolean;
  reason: string;
}

export function signatureStatusLabel(status: PluginSignatureStatus): {
  text: string;
  ok: boolean;
} {
  if (status.signed && status.verified) {
    return { text: status.reason || '签名验证通过', ok: true };
  }
  return { text: status.reason || '未签名', ok: false };
}
