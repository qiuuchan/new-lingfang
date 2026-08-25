import { test, expect } from 'vitest';
import {
  MarketplaceOrderSnapshot,
  MarketplaceOrderPage,
  MarketplaceStatementPage,
  MarketplacePriceProjection,
  MarketplacePriceVersion,
  marketplaceJournalNet,
  splitMarketplacePrice,
} from './marketplace-commerce.ts';

test('platform split floors the platform share and gives the exact remainder to the seller', () => {
  expect(splitMarketplacePrice(1)).toEqual({
    gross_cents: 1,
    platform_fee_bps: 2000,
    platform_amount_cents: 0,
    seller_amount_cents: 1,
  });
  expect(splitMarketplacePrice(101)).toEqual({
    gross_cents: 101,
    platform_fee_bps: 2000,
    platform_amount_cents: 20,
    seller_amount_cents: 81,
  });
  expect(splitMarketplacePrice(99, 3333)).toEqual({
    gross_cents: 99,
    platform_fee_bps: 3333,
    platform_amount_cents: 32,
    seller_amount_cents: 67,
  });
});

test('buyer orders and seller statements share one strict paged order projection', () => {
  const item = {
    id: '11111111-1111-4111-8111-111111111111',
    package_id: '22222222-2222-4222-8222-222222222222',
    package_name: '图片插件',
    release_id: '33333333-3333-4333-8333-333333333333',
    release_version: '1.0.0',
    currency_code: 'CNY',
    list_price_cents: 100,
    discount_cents: 10,
    price_cents: 90,
    platform_fee_bps: 2000,
    platform_cents: 18,
    seller_cents: 72,
    settlement_version: 'SETTLEMENT_V2',
    price_version: `pv1.${'a'.repeat(43)}`,
    campaign_id: null,
    attribution_kind: 'ORGANIC',
    status: 'PENDING_SETTLEMENT',
    created_at: '2026-07-16T00:00:00.000Z',
    settle_at: '2026-07-23T00:00:00.000Z',
    refundable_until: '2026-07-23T00:00:00.000Z',
    settled_at: null,
    refunded_at: null,
    refund_request: null,
  };
  expect(
    MarketplaceOrderPage.safeParse({ items: [item], total: 1, page: 1, pageSize: 20 }).success
  ).toBe(true);
  const totals = { count: 0, gross_cents: 0, seller_cents: 0 };
  const statement = {
    items: [item],
    total: 1,
    page: 1,
    pageSize: 20,
    range: {
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      timezone: 'Asia/Shanghai',
    },
    summary: {
      order_count: 1,
      list_price_cents: 100,
      discount_cents: 10,
      gross_cents: 90,
      platform_cents: 18,
      seller_cents: 72,
      by_status: {
        PENDING_SETTLEMENT: { count: 1, gross_cents: 90, seller_cents: 72 },
        REFUND_REQUESTED: totals,
        SETTLED: totals,
        REFUNDED: totals,
      },
    },
  };
  expect(MarketplaceStatementPage.safeParse(statement).success).toBe(true);
  expect(
    MarketplaceStatementPage.safeParse({ ...statement, buyer_email: 'private@example.com' }).success
  ).toBe(false);
});

test('journal signed deltas prove purchase, refund and settlement conservation', () => {
  expect(
    marketplaceJournalNet([
      { entry_kind: 'BUYER_PURCHASE_DEBIT', direction: 'DEBIT', amount_cents: 101 },
      { entry_kind: 'PLATFORM_PURCHASE_CLEARING_CREDIT', direction: 'CREDIT', amount_cents: 101 },
    ])
  ).toBe(0);
  expect(
    marketplaceJournalNet([
      { entry_kind: 'PLATFORM_REFUND_CLEARING_DEBIT', direction: 'DEBIT', amount_cents: 101 },
      { entry_kind: 'BUYER_REFUND_CREDIT', direction: 'CREDIT', amount_cents: 101 },
    ])
  ).toBe(0);
  expect(
    marketplaceJournalNet([
      { entry_kind: 'PLATFORM_SETTLEMENT_CLEARING_DEBIT', direction: 'DEBIT', amount_cents: 101 },
      { entry_kind: 'SELLER_SETTLEMENT_CREDIT', direction: 'CREDIT', amount_cents: 81 },
      { entry_kind: 'PLATFORM_SETTLEMENT_CREDIT', direction: 'CREDIT', amount_cents: 20 },
    ])
  ).toBe(0);
});

test('public price version is opaque from its first contract version', () => {
  expect(MarketplacePriceVersion.safeParse(`pv1.${'a'.repeat(43)}`).success).toBe(true);
  expect(MarketplacePriceVersion.safeParse('1').success).toBe(false);
  expect(MarketplacePriceVersion.safeParse({ revision: 1 }).success).toBe(false);
});

test('price and order snapshots enforce both pricing and split invariants', () => {
  const price = {
    currency_code: 'CNY',
    list_price_cents: 100,
    discount_amount_cents: 20,
    effective_price_cents: 80,
    price_cents: 80,
    price_version: `pv1.${'a'.repeat(43)}`,
    discount: null,
  };
  expect(MarketplacePriceProjection.safeParse(price).success).toBe(true);
  expect(MarketplacePriceProjection.safeParse({ ...price, price_cents: 81 }).success).toBe(false);
  const order = {
    id: '11111111-1111-4111-8111-111111111111',
    package_id: '22222222-2222-4222-8222-222222222222',
    release_id: '33333333-3333-4333-8333-333333333333',
    buyer_team_id: '44444444-4444-4444-8444-444444444444',
    seller_team_id: '55555555-5555-4555-8555-555555555555',
    buyer_user_id: '66666666-6666-4666-8666-666666666666',
    currency_code: 'CNY',
    list_price_cents: 100,
    discount_amount_cents: 20,
    price_cents: 80,
    platform_fee_bps: 2000,
    platform_amount_cents: 16,
    seller_amount_cents: 64,
    settlement_version: 'SETTLEMENT_V2',
    price_version: `pv1.${'a'.repeat(43)}`,
    discount_id: null,
    discount_revision: null,
    campaign_id: null,
    attribution_kind: 'ORGANIC',
    status: 'PENDING_SETTLEMENT',
    created_at: '2026-07-16T00:00:00.000Z',
    settle_at: '2026-07-23T00:00:00.000Z',
    refundable_until: '2026-07-23T00:00:00.000Z',
    settled_at: null,
    refunded_at: null,
  };
  expect(MarketplaceOrderSnapshot.safeParse(order).success).toBe(true);
  expect(MarketplaceOrderSnapshot.safeParse({ ...order, seller_amount_cents: 65 }).success).toBe(
    false
  );
});
