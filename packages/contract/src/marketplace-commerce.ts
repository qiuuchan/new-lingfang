import { z } from 'zod';
import { StrictSemVer } from './semver.ts';

export const CNY_CENTS_MAX = 2_147_483_647;
export const MARKETPLACE_DEFAULT_PLATFORM_FEE_BPS = 2_000;
export const MARKETPLACE_REFUND_WINDOW_DAYS = 7;

export const CnyCents = z.number().int().min(0).max(CNY_CENTS_MAX);
export type CnyCents = z.infer<typeof CnyCents>;
export const MarketplaceBasisPoints = z.number().int().min(0).max(10_000);
export type MarketplaceBasisPoints = z.infer<typeof MarketplaceBasisPoints>;
export const MarketplacePriceVersion = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^pv1\.[A-Za-z0-9_-]{43}$/);
export type MarketplacePriceVersion = z.infer<typeof MarketplacePriceVersion>;

export const MarketplaceSettlementVersion = z.enum(['LEGACY_V1', 'SETTLEMENT_V2']);
export type MarketplaceSettlementVersion = z.infer<typeof MarketplaceSettlementVersion>;
export const MarketplaceOrderStatus = z.enum([
  'PENDING_SETTLEMENT',
  'REFUND_REQUESTED',
  'SETTLED',
  'REFUNDED',
]);
export type MarketplaceOrderStatus = z.infer<typeof MarketplaceOrderStatus>;
export const MarketplaceEntitlementStatus = z.enum(['ACTIVE', 'REVOKED']);
export type MarketplaceEntitlementStatus = z.infer<typeof MarketplaceEntitlementStatus>;
export const MarketplaceCommerceWriterMode = z.enum([
  'LEGACY',
  'DRAINING',
  'SETTLEMENT_V2',
  'PAUSED',
]);
export type MarketplaceCommerceWriterMode = z.infer<typeof MarketplaceCommerceWriterMode>;
export const MarketplacePlatformAccountKind = z.enum([
  'MARKETPLACE_CLEARING',
  'MARKETPLACE_REVENUE',
]);
export type MarketplacePlatformAccountKind = z.infer<typeof MarketplacePlatformAccountKind>;
export const MarketplaceRefundRequestStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED']);
export type MarketplaceRefundRequestStatus = z.infer<typeof MarketplaceRefundRequestStatus>;
export const MarketplaceCampaignStatus = z.enum(['DRAFT', 'PUBLISHED', 'CANCELED']);
export type MarketplaceCampaignStatus = z.infer<typeof MarketplaceCampaignStatus>;
export const MarketplaceAttributionKind = z.enum(['ORGANIC', 'CAMPAIGN']);
export type MarketplaceAttributionKind = z.infer<typeof MarketplaceAttributionKind>;
export const MarketplacePurchaseResultKind = z.enum(['ENTITLED_EXISTING', 'ORDER_CREATED']);
export type MarketplacePurchaseResultKind = z.infer<typeof MarketplacePurchaseResultKind>;

export const MarketplaceLedgerEntryKind = z.enum([
  'BUYER_PURCHASE_DEBIT',
  'PLATFORM_PURCHASE_CLEARING_CREDIT',
  'BUYER_REFUND_CREDIT',
  'PLATFORM_REFUND_CLEARING_DEBIT',
  'PLATFORM_SETTLEMENT_CLEARING_DEBIT',
  'SELLER_SETTLEMENT_CREDIT',
  'PLATFORM_SETTLEMENT_CREDIT',
]);
export type MarketplaceLedgerEntryKind = z.infer<typeof MarketplaceLedgerEntryKind>;

export const MarketplaceCommerceErrorCode = z.enum([
  'marketplace_price_changed',
  'marketplace_idempotency_conflict',
  'marketplace_commerce_paused',
  'marketplace_discount_invalid',
  'marketplace_discount_overlap',
  'marketplace_refund_window_closed',
  'marketplace_refund_state_conflict',
  'marketplace_settlement_state_conflict',
  'marketplace_journal_unbalanced',
]);

export const MarketplacePriceSplit = z
  .object({
    gross_cents: CnyCents,
    platform_fee_bps: MarketplaceBasisPoints,
    platform_amount_cents: CnyCents,
    seller_amount_cents: CnyCents,
  })
  .strict();
export type MarketplacePriceSplit = z.infer<typeof MarketplacePriceSplit>;

export const MarketplaceDiscountSummary = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    price_cents: CnyCents.min(1),
    starts_at: z.string().datetime(),
    ends_at: z.string().datetime(),
  })
  .strict();
export type MarketplaceDiscountSummary = z.infer<typeof MarketplaceDiscountSummary>;

export const MarketplacePriceProjection = z
  .object({
    currency_code: z.literal('CNY'),
    list_price_cents: CnyCents,
    discount_amount_cents: CnyCents,
    effective_price_cents: CnyCents,
    price_cents: CnyCents,
    price_version: MarketplacePriceVersion,
    discount: MarketplaceDiscountSummary.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.list_price_cents - value.discount_amount_cents !== value.effective_price_cents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discount_amount_cents'],
        message: 'list price minus discount must equal effective price',
      });
    }
    if (value.price_cents !== value.effective_price_cents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['price_cents'],
        message: 'legacy price_cents must project the effective price',
      });
    }
  });
export type MarketplacePriceProjection = z.infer<typeof MarketplacePriceProjection>;

export const MarketplaceOrderSnapshot = z
  .object({
    id: z.string().uuid(),
    package_id: z.string().uuid(),
    release_id: z.string().uuid(),
    buyer_team_id: z.string().uuid(),
    seller_team_id: z.string().uuid(),
    buyer_user_id: z.string().uuid(),
    currency_code: z.literal('CNY'),
    list_price_cents: CnyCents,
    discount_amount_cents: CnyCents,
    price_cents: CnyCents,
    platform_fee_bps: MarketplaceBasisPoints,
    platform_amount_cents: CnyCents,
    seller_amount_cents: CnyCents,
    settlement_version: z.literal('SETTLEMENT_V2'),
    price_version: MarketplacePriceVersion,
    discount_id: z.string().uuid().nullable(),
    discount_revision: z.number().int().positive().nullable(),
    campaign_id: z.string().uuid().nullable(),
    attribution_kind: MarketplaceAttributionKind,
    status: MarketplaceOrderStatus,
    created_at: z.string().datetime(),
    settle_at: z.string().datetime(),
    refundable_until: z.string().datetime(),
    settled_at: z.string().datetime().nullable(),
    refunded_at: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.list_price_cents - value.discount_amount_cents !== value.price_cents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['price_cents'],
        message: 'order price snapshot is inconsistent',
      });
    }
    if (value.platform_amount_cents + value.seller_amount_cents !== value.price_cents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['platform_amount_cents'],
        message: 'order split is inconsistent',
      });
    }
  });
export type MarketplaceOrderSnapshot = z.infer<typeof MarketplaceOrderSnapshot>;

export const MarketplacePurchaseRequest = z
  .object({
    expected_price_version: MarketplacePriceVersion.optional(),
    attribution_token: z.string().trim().min(1).max(2048).optional(),
  })
  .strict();
export type MarketplacePurchaseRequest = z.infer<typeof MarketplacePurchaseRequest>;

export const MarketplacePurchaseResponse = z
  .object({
    entitled: z.boolean(),
    entitlement_id: z.string().uuid(),
    purchase_id: z.string().uuid().nullable(),
    result_kind: MarketplacePurchaseResultKind,
    order: MarketplaceOrderSnapshot.nullable(),
  })
  .strict();
export type MarketplacePurchaseResponse = z.infer<typeof MarketplacePurchaseResponse>;

export const MarketplaceRefundRequest = z
  .object({
    id: z.string().uuid(),
    purchase_id: z.string().uuid(),
    status: MarketplaceRefundRequestStatus,
    reason: z.string().trim().min(1).max(1000),
    requested_at: z.string().datetime(),
    reviewed_at: z.string().datetime().nullable(),
    review_reason: z.string().max(1000),
  })
  .strict();
export type MarketplaceRefundRequest = z.infer<typeof MarketplaceRefundRequest>;

export const MarketplaceOrderListItem = z
  .object({
    id: z.string().uuid(),
    package_id: z.string().uuid().nullable(),
    package_name: z.string().min(1).max(128),
    release_id: z.string().uuid().nullable(),
    release_version: StrictSemVer.nullable(),
    currency_code: z.literal('CNY'),
    list_price_cents: CnyCents,
    discount_cents: CnyCents,
    price_cents: CnyCents,
    platform_fee_bps: MarketplaceBasisPoints,
    platform_cents: CnyCents,
    seller_cents: CnyCents,
    settlement_version: MarketplaceSettlementVersion,
    price_version: z.string().trim().min(1).max(128),
    campaign_id: z.string().uuid().nullable(),
    attribution_kind: MarketplaceAttributionKind,
    status: MarketplaceOrderStatus,
    created_at: z.string().datetime(),
    settle_at: z.string().datetime().nullable(),
    refundable_until: z.string().datetime().nullable(),
    settled_at: z.string().datetime().nullable(),
    refunded_at: z.string().datetime().nullable(),
    refund_request: MarketplaceRefundRequest.nullable(),
  })
  .strict();
export type MarketplaceOrderListItem = z.infer<typeof MarketplaceOrderListItem>;

export const MarketplaceOrderPage = z
  .object({
    items: z.array(MarketplaceOrderListItem),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive().max(100),
  })
  .strict();
export type MarketplaceOrderPage = z.infer<typeof MarketplaceOrderPage>;

const MarketplaceStatementStatusTotals = z
  .object({ count: z.number().int().nonnegative(), gross_cents: CnyCents, seller_cents: CnyCents })
  .strict();
export const MarketplaceStatementSummary = z
  .object({
    order_count: z.number().int().nonnegative(),
    list_price_cents: CnyCents,
    discount_cents: CnyCents,
    gross_cents: CnyCents,
    platform_cents: CnyCents,
    seller_cents: CnyCents,
    by_status: z
      .object({
        PENDING_SETTLEMENT: MarketplaceStatementStatusTotals,
        REFUND_REQUESTED: MarketplaceStatementStatusTotals,
        SETTLED: MarketplaceStatementStatusTotals,
        REFUNDED: MarketplaceStatementStatusTotals,
      })
      .strict(),
  })
  .strict();
export type MarketplaceStatementSummary = z.infer<typeof MarketplaceStatementSummary>;

export const MarketplaceStatementPage = MarketplaceOrderPage.extend({
  range: z
    .object({
      from: z.string().datetime(),
      to: z.string().datetime(),
      timezone: z.string().min(1).max(100),
    })
    .strict(),
  summary: MarketplaceStatementSummary,
}).strict();
export type MarketplaceStatementPage = z.infer<typeof MarketplaceStatementPage>;

const MarketplaceDailyTotals = z
  .object({ count: z.number().int().nonnegative(), gross_cents: CnyCents, seller_cents: CnyCents })
  .strict();
export const MarketplaceStatementDaily = z
  .object({
    range: z
      .object({
        from: z.string().datetime(),
        to: z.string().datetime(),
        timezone: z.string().min(1).max(100),
      })
      .strict(),
    items: z.array(
      z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          order_created: MarketplaceDailyTotals,
          refund_approved: MarketplaceDailyTotals,
          settled: MarketplaceDailyTotals,
        })
        .strict()
    ),
  })
  .strict();
export type MarketplaceStatementDaily = z.infer<typeof MarketplaceStatementDaily>;

export const CreateMarketplaceDiscountRequest = z
  .object({
    price_cents: CnyCents.min(1),
    starts_at: z.string().datetime(),
    ends_at: z.string().datetime(),
  })
  .strict();
export const MarketplaceCampaign = z
  .object({
    id: z.string().uuid(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(128),
    description: z.string().max(4096),
    starts_at: z.string().datetime(),
    ends_at: z.string().datetime(),
    status: MarketplaceCampaignStatus,
    items: z
      .array(
        z.object({ package_id: z.string().uuid(), rank: z.number().int().nonnegative() }).strict()
      )
      .max(100),
  })
  .strict();

export const MarketplaceCampaignAttributionToken = z
  .object({
    campaign_token: z.string().trim().min(1).max(4096),
    expires_at: z.string().datetime(),
  })
  .strict();
export type MarketplaceCampaignAttributionToken = z.infer<
  typeof MarketplaceCampaignAttributionToken
>;

export const MarketplaceJournalEntry = z
  .object({
    entry_kind: MarketplaceLedgerEntryKind,
    direction: z.enum(['CREDIT', 'DEBIT']),
    amount_cents: CnyCents,
  })
  .strict();
export type MarketplaceJournalEntry = z.infer<typeof MarketplaceJournalEntry>;

export function splitMarketplacePrice(
  grossCents: number,
  platformFeeBps = MARKETPLACE_DEFAULT_PLATFORM_FEE_BPS
): MarketplacePriceSplit {
  const gross = CnyCents.parse(grossCents);
  const fee = MarketplaceBasisPoints.parse(platformFeeBps);
  const platform = Math.floor((gross * fee) / 10_000);
  return MarketplacePriceSplit.parse({
    gross_cents: gross,
    platform_fee_bps: fee,
    platform_amount_cents: platform,
    seller_amount_cents: gross - platform,
  });
}

export function marketplaceJournalNet(entries: readonly MarketplaceJournalEntry[]): number {
  return entries.reduce(
    (sum, entry) => sum + (entry.direction === 'CREDIT' ? entry.amount_cents : -entry.amount_cents),
    0
  );
}
