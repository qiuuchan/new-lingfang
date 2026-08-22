import { z } from 'zod';
import {
  MarketplaceCategory,
  MarketplaceQualityTier,
  PublicPluginCard,
  type MarketplaceCategory as MarketplaceCategoryValue,
} from './web-plugin-center.ts';

export const MarketplaceMetricKind = z.enum([
  'INSTALL_SUCCEEDED',
  'RUN_SUCCEEDED',
  'RUN_FAILED',
  'RATING_CHANGED',
  'PURCHASED',
  'REFUNDED',
  'SECURITY_BLOCKED',
  'SECURITY_CLEARED',
]);
export type MarketplaceMetricKind = z.infer<typeof MarketplaceMetricKind>;

export const MarketplaceMetricSource = z.enum([
  'DESKTOP_HOST',
  'CLOUD_RUNTIME',
  'WORKFLOW_RUNTIME',
  'REGISTRY',
  'COMMERCE',
  'SECURITY',
]);
export type MarketplaceMetricSource = z.infer<typeof MarketplaceMetricSource>;

export const MarketplaceQualityReason = z.enum([
  'hard_gate_failed',
  'listing_age_insufficient',
  'release_age_insufficient',
  'insufficient_active_teams',
  'insufficient_observed_runs',
  'failure_rate_high',
  'insufficient_rating_teams',
  'average_rating_low',
  'refund_data_unavailable',
  'insufficient_matured_paid_orders',
  'refund_rate_high',
  'security_blocked',
  'anomaly_review_required',
  'quality_blocked',
]);
export type MarketplaceQualityReason = z.infer<typeof MarketplaceQualityReason>;

export const MarketplaceRefundMetricState = z.enum([
  'AVAILABLE',
  'NOT_APPLICABLE',
  'INSUFFICIENT_SAMPLE',
  'DATA_UNAVAILABLE',
]);
export type MarketplaceRefundMetricState = z.infer<typeof MarketplaceRefundMetricState>;

export const MarketplaceDiscoverySection = z.enum([
  'FEATURED',
  'CATEGORY_POPULAR',
  'RECENT_QUALITY',
]);
export type MarketplaceDiscoverySection = z.infer<typeof MarketplaceDiscoverySection>;

export const MARKETPLACE_CATEGORY_LABELS: Readonly<Record<MarketplaceCategoryValue, string>> =
  Object.freeze({
    AI: 'AI 与助手',
    PRODUCTIVITY: '效率与办公',
    DEV: '开发工具',
    DATA: '数据与可视化',
    MEDIA: '图像与多媒体',
    FILES: '文件与存储',
    NETWORK: '网络与接口',
    SYSTEM: '系统与监控',
    OTHER: '其他',
  });

export const MarketplaceQualityPolicy = z
  .object({
    version: z.literal(1),
    listing_age_days: z.number().int().positive(),
    current_release_activation_age_days: z.number().int().positive(),
    active_teams_30d: z.number().int().positive(),
    observed_runs_30d: z.number().int().positive(),
    max_failure_rate_bps: z.number().int().min(0).max(10_000),
    rating_teams: z.number().int().positive(),
    min_average_rating_tenths: z.number().int().min(0).max(50),
    matured_paid_orders_90d: z.number().int().positive(),
    max_refund_rate_bps: z.number().int().min(0).max(10_000),
    security_lookback_days: z.number().int().positive(),
  })
  .strict();
export type MarketplaceQualityPolicy = z.infer<typeof MarketplaceQualityPolicy>;

export const MARKETPLACE_QUALITY_POLICY_V1: MarketplaceQualityPolicy = Object.freeze({
  version: 1,
  listing_age_days: 14,
  current_release_activation_age_days: 7,
  active_teams_30d: 20,
  observed_runs_30d: 50,
  max_failure_rate_bps: 200,
  rating_teams: 10,
  min_average_rating_tenths: 43,
  matured_paid_orders_90d: 10,
  max_refund_rate_bps: 500,
  security_lookback_days: 90,
});

export const MarketplaceQualityReasonDetail = z
  .object({
    code: MarketplaceQualityReason,
    actual: z.number().int().nonnegative().nullable(),
    threshold: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type MarketplaceQualityReasonDetail = z.infer<typeof MarketplaceQualityReasonDetail>;

export const MarketplaceQualityMetricSummary = z
  .object({
    listing_age_days: z.number().int().nonnegative(),
    current_release_age_days: z.number().int().nonnegative(),
    active_teams_30d: z.number().int().nonnegative(),
    install_teams_30d: z.number().int().nonnegative(),
    observed_runs_30d: z.number().int().nonnegative(),
    failed_runs_30d: z.number().int().nonnegative(),
    failure_rate_bps: z.number().int().min(0).max(10_000).nullable(),
    rating_teams: z.number().int().nonnegative(),
    rating_sum: z.number().int().nonnegative(),
    average_rating_tenths: z.number().int().min(0).max(50).nullable(),
    refund_metric_state: MarketplaceRefundMetricState,
    matured_paid_orders_90d: z.number().int().nonnegative(),
    approved_refunds_90d: z.number().int().nonnegative(),
    refund_rate_bps: z.number().int().min(0).max(10_000).nullable(),
    security_incidents_90d: z.number().int().nonnegative(),
  })
  .strict();
export type MarketplaceQualityMetricSummary = z.infer<typeof MarketplaceQualityMetricSummary>;

export const MarketplaceQualitySummary = z
  .object({
    tier: MarketplaceQualityTier,
    auto_qualified: z.boolean(),
    policy_version: z.literal(1),
    fact_watermark: z.string().datetime(),
    computed_at: z.string().datetime(),
    qualified_at: z.string().datetime().nullable(),
    stale: z.boolean(),
    metrics: MarketplaceQualityMetricSummary,
    reasons: z.array(MarketplaceQualityReasonDetail),
  })
  .strict();
export type MarketplaceQualitySummary = z.infer<typeof MarketplaceQualitySummary>;

export const MarketplaceOwnerQuality = z
  .object({
    packageId: z.string().uuid(),
    category: MarketplaceCategory,
    tier: MarketplaceQualityTier,
    policy: MarketplaceQualityPolicy,
    snapshot: MarketplaceQualitySummary.nullable(),
    qualityBlocked: z
      .object({
        at: z.string().datetime(),
        reason: z.string(),
      })
      .strict()
      .nullable(),
    featured: z
      .object({
        at: z.string().datetime(),
        until: z.string().datetime().nullable(),
        reason: z.string(),
        rank: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type MarketplaceOwnerQuality = z.infer<typeof MarketplaceOwnerQuality>;

export const MarketplaceDiscoveryItem = PublicPluginCard.extend({
  quality: MarketplaceQualitySummary,
})
  .strict()
  .superRefine((item, ctx) => {
    if (item.quality_tier !== item.quality.tier)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quality_tier'],
        message: 'quality_tier must match quality.tier',
      });
  });
export type MarketplaceDiscoveryItem = z.infer<typeof MarketplaceDiscoveryItem>;

export const MarketplaceDiscoveryHome = z
  .object({
    policy: MarketplaceQualityPolicy,
    generated_at: z.string().datetime(),
    category: MarketplaceCategory.nullable(),
    featured: z.array(MarketplaceDiscoveryItem).max(20),
    category_popular: z.array(MarketplaceDiscoveryItem).max(20),
    recent_quality: z.array(MarketplaceDiscoveryItem).max(20),
  })
  .strict();
export type MarketplaceDiscoveryHome = z.infer<typeof MarketplaceDiscoveryHome>;

export const MarketplaceDiscoveryPage = z
  .object({
    section: MarketplaceDiscoverySection,
    category: MarketplaceCategory.nullable(),
    page: z.number().int().positive(),
    page_size: z.number().int().min(1).max(100),
    total: z.number().int().nonnegative(),
    items: z.array(MarketplaceDiscoveryItem),
  })
  .strict();
export type MarketplaceDiscoveryPage = z.infer<typeof MarketplaceDiscoveryPage>;

const CATEGORY_KEYWORDS: ReadonlyArray<readonly [MarketplaceCategoryValue, readonly string[]]> = [
  [
    'AI',
    [
      'ai',
      'gpt',
      'llm',
      '助手',
      '对话',
      'chat',
      '总结',
      '翻译',
      '摘要',
      'assistant',
      '写作',
      '大模型',
    ],
  ],
  [
    'PRODUCTIVITY',
    [
      '笔记',
      'note',
      'todo',
      '任务',
      '待办',
      '日历',
      '会议',
      '纪要',
      '效率',
      '清单',
      '看板',
      'kanban',
    ],
  ],
  [
    'DEV',
    [
      '代码',
      '开发',
      'code',
      'dev',
      'git',
      '构建',
      '编译',
      '调试',
      'debug',
      'sdk',
      '命令行',
      'cli',
      '终端',
    ],
  ],
  [
    'DATA',
    ['可视化', '数据分析', 'chart', '图表', '统计', '报表', 'excel', '表格', 'csv', 'dashboard'],
  ],
  [
    'MEDIA',
    [
      '图片',
      '图像',
      '视频',
      '音频',
      '音乐',
      'image',
      'video',
      'audio',
      '剪辑',
      '压缩',
      '转码',
      '水印',
    ],
  ],
  [
    'FILES',
    [
      '文件',
      'file',
      '资源管理',
      '目录',
      '搜索文件',
      '同步',
      '云盘',
      '备份',
      'archive',
      'zip',
      '解压',
    ],
  ],
  [
    'NETWORK',
    ['网络', '请求', 'http', 'api', '爬虫', '抓取', '代理', 'proxy', '测速', 'dns', '下载器'],
  ],
  ['SYSTEM', ['系统', '监控', '性能', 'system', '进程', '硬件', 'cpu', '内存', '磁盘', '通知']],
];

export function inferMarketplaceCategory(input: {
  name: string;
  description?: string;
  runtime_type?: string;
  capabilities?: ReadonlyArray<string>;
}): MarketplaceCategoryValue {
  const text = [
    input.name,
    input.description ?? '',
    input.runtime_type ?? '',
    ...(input.capabilities ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return (
    CATEGORY_KEYWORDS.find(([, keywords]) =>
      keywords.some((keyword) => text.includes(keyword))
    )?.[0] ?? 'OTHER'
  );
}
