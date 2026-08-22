// time.ts — 时间戳解析/格式化统一工具。
//
// 背景（Task 4a「Invalid Date」修复）：
// 旧版 Rust 后端把 started_at / 会话时间序列化为 `epoch秒.毫秒Z`（如 `1719045678.123Z`），
// 该格式既非 ISO 8601 也非 RFC 2822，浏览器 new Date(...) 无法解析，toLocalString 直接
// 返回字符串 "Invalid Date"。新后端已改为标准 RFC 3339（见 Rust epoch_to_iso8601），
// 此处对前端再做一层防御性解析：兼容新旧两种格式 + 旧数据落盘记录，确保历史会话也能正常展示。
//
// 解析顺序：
//   1. 纯数字串（≤ 11 位视为秒，否则视为毫秒）—— 适配「1719045678」「1719045678123」。
//   2. `数字.毫秒Z` 旧格式（如 `1719045678.123Z`）—— 按秒解析。
//   3. 标准 ISO 8601 / RFC 2822 —— 直接交给 Date。
//   4. 全部失败返回 null（调用方降级展示）。

/** 把任意历史/当前格式的时间戳解析为 Date；无法识别返回 null。 */
export function parseTimestamp(value: string | number | null | undefined): Date | null {
  if (value == null) return null;
  if (typeof value === 'number') return epochSecondsOrMillis(value);
  const raw = value.trim();
  if (!raw) return null;

  // 旧格式：`<epoch秒>.<毫秒>Z`（Rust 旧 now_string 产物）。
  const legacy = raw.match(/^(\d{1,11})\.(\d{1,3})Z?$/);
  if (legacy) {
    const secs = Number(legacy[1]);
    const ms = Number(legacy[2].padEnd(3, '0').slice(0, 3));
    const d = new Date(secs * 1000 + ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // 纯数字串：≤ 11 位按秒（1970–2286 区间），否则按毫秒。
  if (/^\d+$/.test(raw)) return epochSecondsOrMillis(Number(raw));

  // 标准 ISO 8601 / RFC 2822。
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function epochSecondsOrMillis(n: number): Date | null {
  // 11 位秒约到 5138 年；10 位秒 = 2001–2286。超过 11 位认定为毫秒。
  const d = new Date(String(n).length <= 11 ? n * 1000 : n);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 时间戳 → zh-CN 本地时间（24h）。解析失败返回 fallback（默认 '—'）。 */
export function formatTimestamp(value: string | number | null | undefined, fallback = '—'): string {
  const d = parseTimestamp(value);
  if (!d) return fallback;
  try {
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return fallback;
  }
}

/** 时间戳 → zh-CN 日期（如 2024/6/22）。解析失败返回 fallback。 */
export function formatDate(value: string | number | null | undefined, fallback = '—'): string {
  const d = parseTimestamp(value);
  if (!d) return fallback;
  try {
    return d.toLocaleDateString('zh-CN');
  } catch {
    return fallback;
  }
}

/**
 * 相对时间（如「3 分钟前」）。解析失败返回 fallback。
 * 阈值：60s/60m/24h/7d，超出回退到绝对日期。
 */
export function relativeTime(value: string | number | null | undefined, fallback = '—'): string {
  const d = parseTimestamp(value);
  if (!d) return fallback;
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return formatTimestamp(value, fallback);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return formatDate(value, fallback);
}
