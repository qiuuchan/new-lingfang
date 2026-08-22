import { test, expect } from 'vitest';
import {
  MarketplaceDiscoveryHome,
  MarketplaceQualityMetricSummary,
  inferMarketplaceCategory,
  MARKETPLACE_QUALITY_POLICY_V1,
} from './marketplace-discovery.ts';
import { PluginCatalogItem } from './plugin-registry.ts';
import { MarketplaceCategory, MarketplaceQualityTier } from './web-plugin-center.ts';

test('quality/category enums expose only the public three-tier and nine-category vocabulary', () => {
  expect(MarketplaceQualityTier.options).toEqual(['LISTED', 'QUALITY', 'FEATURED']);
  expect(MarketplaceCategory.options.length).toBe(9);
  expect(MarketplaceQualityTier.safeParse('PREMIUM').success).toBe(false);
  expect(MarketplaceCategory.safeParse('UNKNOWN').success).toBe(false);
});

test('quality policy v1 is the exact public integer threshold source', () => {
  expect(MARKETPLACE_QUALITY_POLICY_V1).toEqual({
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
});

test('quality metrics reject floating rates, invalid denominators and unknown fields', () => {
  const metrics = {
    listing_age_days: 14,
    current_release_age_days: 7,
    active_teams_30d: 20,
    install_teams_30d: 3,
    observed_runs_30d: 50,
    failed_runs_30d: 1,
    failure_rate_bps: 200,
    rating_teams: 10,
    rating_sum: 43,
    average_rating_tenths: 43,
    refund_metric_state: 'NOT_APPLICABLE',
    matured_paid_orders_90d: 0,
    approved_refunds_90d: 0,
    refund_rate_bps: null,
    security_incidents_90d: 0,
  };
  expect(MarketplaceQualityMetricSummary.parse(metrics).failure_rate_bps).toBe(200);
  expect(() =>
    MarketplaceQualityMetricSummary.parse({ ...metrics, failure_rate_bps: 2.5 })
  ).toThrow();
  expect(() =>
    MarketplaceQualityMetricSummary.parse({ ...metrics, legacy_install_count: 999 })
  ).toThrow();
});

test('deterministic category inference centralizes the existing keyword priority', () => {
  expect(inferMarketplaceCategory({ name: 'AI 代码助手', description: '生成代码' })).toBe('AI');
  expect(inferMarketplaceCategory({ name: '会议纪要生成器', description: '整理待办' })).toBe(
    'PRODUCTIVITY'
  );
  expect(inferMarketplaceCategory({ name: 'HTTP 爬虫', description: '抓取接口数据' })).toBe(
    'NETWORK'
  );
  expect(inferMarketplaceCategory({ name: '神秘插件' })).toBe('OTHER');
});

test('old catalog payload remains valid while discovery responses stay strict', () => {
  const oldItem = {
    package: {
      id: '11111111-1111-4111-8111-111111111111',
      ownerTeamId: '22222222-2222-4222-8222-222222222222',
      authorUserId: null,
      manifestId: 'demo',
      name: 'Demo',
      description: '',
      governanceStatus: 'ACTIVE',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    },
    latestRelease: {
      id: '33333333-3333-4333-8333-333333333333',
      packageId: '11111111-1111-4111-8111-111111111111',
      version: '1.0.0',
      manifest: {
        manifest_version: 4,
        id: 'demo',
        name: 'Demo',
        version: '1.0.0',
        runtime_type: 'client',
        entry: 'index.js',
        capabilities: [],
        actions: [],
        action_dependencies: [],
      },
      package_policy_surface_sha256: '0'.repeat(64),
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
      status: 'PUBLISHED',
      marketReviewStatus: 'APPROVED',
      targetPlatform: 'windows-x64',
      sourceKind: 'API',
      sourceLabel: '',
      ingestChannel: 'API',
      aiPolicyVersion: 1,
      aiPolicyStatus: 'PASSED',
      aiPolicyReason: '',
      createdAt: '2026-07-16T00:00:00.000Z',
    },
  };
  expect(PluginCatalogItem.safeParse(oldItem).success).toBe(true);
  expect(
    MarketplaceDiscoveryHome.safeParse({
      policy: MARKETPLACE_QUALITY_POLICY_V1,
      generated_at: '2026-07-16T00:00:00.000Z',
      category: null,
      featured: [],
      category_popular: [],
      recent_quality: [],
      legacy_items: [],
    }).success
  ).toBe(false);
});
