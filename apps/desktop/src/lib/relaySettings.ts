// relaySettings.ts — relay 凭据的纯校验逻辑（IMPROVEMENT_PLAN F5，无 React 依赖便于单测）。
//
// api_base 非空时必须是合法 https:// URL（硬校验，阻断保存）：凭据会随请求发往该地址，
// 明文 http 会在网络上暴露 token。空串 = 清除配置，视为合法。
// auth_token 不猜格式（各 relay 前缀约定不同），仅对"含空白字符"这一明显复制失误
// 给出非阻断提示。

export function validateRelayApiBase(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'API Base 必须是合法 URL（如 https://relay.example.com/v1）';
  }
  if (url.protocol !== 'https:') {
    return 'API Base 必须使用 https://（明文 http 会暴露凭据）';
  }
  return null;
}

export function relayTokenHint(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/\s/.test(value)) return '令牌含空白字符，请检查是否复制完整';
  return null;
}
