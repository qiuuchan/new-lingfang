import { z } from 'zod';
import { RuntimeType } from './plugin.ts';
import { Sha256Hex } from './plugin-registry.ts';
import { StrictSemVer } from './semver.ts';
import { ActionId, ActionInvocationStatus, ActionSchema, ActionTarget } from './plugin-action.ts';

export const MarketplaceCategory = z.enum([
  'AI',
  'PRODUCTIVITY',
  'DEV',
  'DATA',
  'MEDIA',
  'FILES',
  'NETWORK',
  'SYSTEM',
  'OTHER',
]);
export type MarketplaceCategory = z.infer<typeof MarketplaceCategory>;

export const MarketplaceQualityTier = z.enum(['LISTED', 'QUALITY', 'FEATURED']);
export type MarketplaceQualityTier = z.infer<typeof MarketplaceQualityTier>;

export const WebPluginPreviewMode = z.enum(['CLIENT_SANDBOX', 'CLOUD_TRIAL', 'STATIC_DESKTOP']);
export type WebPluginPreviewMode = z.infer<typeof WebPluginPreviewMode>;

export const WebPreviewSession = z
  .object({
    session_id: z.string().uuid(),
    release_id: z.string().uuid(),
    release_sha256: Sha256Hex,
    mode: WebPluginPreviewMode,
    expires_at: z.string().datetime(),
    channel_nonce: z.string().min(32).max(256),
  })
  .strict();
export type WebPreviewSession = z.infer<typeof WebPreviewSession>;

export const WebCloudTrialCreateRequest = z
  .object({
    release_id: z.string().uuid(),
    release_sha256: Sha256Hex,
    action_contract_version: StrictSemVer,
    action_surface_sha256: Sha256Hex,
    input: z.record(z.unknown()),
    request_idempotency_key: z.string().trim().min(1).max(256),
  })
  .strict();
export type WebCloudTrialCreateRequest = z.infer<typeof WebCloudTrialCreateRequest>;

export const WebCloudPreviewAction = z
  .object({
    action_id: ActionId,
    name: z.string().trim().min(1).max(128),
    description: z.string().max(4096),
    action_contract_version: StrictSemVer,
    action_surface_sha256: Sha256Hex,
    input_schema: ActionSchema,
  })
  .strict();
export type WebCloudPreviewAction = z.infer<typeof WebCloudPreviewAction>;

export const WebCloudTrialProjection = z
  .object({
    invocation_id: z.string().uuid(),
    status: ActionInvocationStatus,
    target: ActionTarget,
    quota_remaining: z.number().int().nonnegative(),
    daily_limit: z.number().int().positive(),
    concurrency_limit: z.number().int().positive(),
    concurrent_active: z.number().int().nonnegative(),
    quota_reset_at: z.string().datetime(),
    expires_at: z.string().datetime(),
    policy_decision_id: z.string().trim().min(1).max(128),
    output: z.record(z.unknown()).nullable(),
    error: z
      .object({ code: z.string().trim().min(1).max(128), message: z.string().max(1000) })
      .strict()
      .nullable(),
    created_at: z.string().datetime(),
    started_at: z.string().datetime().nullable(),
    completed_at: z.string().datetime().nullable(),
  })
  .strict();
export type WebCloudTrialProjection = z.infer<typeof WebCloudTrialProjection>;

export const WebPluginCompatibility = z
  .object({
    runtime_type: RuntimeType,
    desktop_platforms: z.array(z.string().trim().min(1).max(64)).max(16),
    minimum_desktop_version: StrictSemVer.nullable(),
    web_compatible: z.boolean(),
  })
  .strict();
export type WebPluginCompatibility = z.infer<typeof WebPluginCompatibility>;

export const PublicPluginCard = z
  .object({
    package_id: z.string().uuid(),
    listing_id: z.string().uuid(),
    release_id: z.string().uuid(),
    name: z.string().trim().min(1).max(128),
    summary: z.string().max(4096),
    author_display_name: z.string().trim().min(1).max(128).nullable(),
    category: MarketplaceCategory,
    runtime_type: RuntimeType,
    quality_tier: MarketplaceQualityTier,
    version: StrictSemVer,
    install_count: z.number().int().nonnegative(),
    rating_count: z.number().int().nonnegative(),
    average_rating_tenths: z.number().int().min(0).max(50),
    base_price_cents: z.number().int().nonnegative(),
    discount_amount_cents: z.number().int().nonnegative().optional(),
    effective_price_cents: z.number().int().nonnegative().optional(),
    price_version: z.string().trim().min(1).max(128),
    preview_mode: WebPluginPreviewMode,
    updated_at: z.string().datetime(),
  })
  .strict();
export type PublicPluginCard = z.infer<typeof PublicPluginCard>;

export const PublicPluginDetail = PublicPluginCard.extend({
  readme_markdown: z.string().max(256 * 1024),
  release_sha256: Sha256Hex,
  compatibility: WebPluginCompatibility,
  preview_actions: z.array(WebCloudPreviewAction).max(32),
}).strict();
export type PublicPluginDetail = z.infer<typeof PublicPluginDetail>;

export const WebPluginCatalogSort = z.enum(['RECENT', 'POPULAR', 'RATING', 'NAME']);
export const WebPluginPriceFilter = z.enum(['ALL', 'FREE', 'PAID']);
export const WebPluginCompatibilityFilter = z.enum(['ALL', 'WEB', 'DESKTOP']);

export const WebPluginCatalogQuery = z
  .object({
    q: z.string().trim().max(128).default(''),
    category: MarketplaceCategory.optional(),
    runtime_type: RuntimeType.optional(),
    quality_tier: MarketplaceQualityTier.optional(),
    price: WebPluginPriceFilter.default('ALL'),
    compatibility: WebPluginCompatibilityFilter.default('ALL'),
    sort: WebPluginCatalogSort.default('POPULAR'),
    page: z.coerce.number().int().positive().default(1),
    page_size: z.coerce.number().int().min(1).max(50).default(24),
  })
  .strict();
export type WebPluginCatalogQuery = z.infer<typeof WebPluginCatalogQuery>;

export const PublicPluginCatalogPage = z
  .object({
    items: z.array(PublicPluginCard),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    page_size: z.number().int().positive().max(50),
  })
  .strict();
export type PublicPluginCatalogPage = z.infer<typeof PublicPluginCatalogPage>;
