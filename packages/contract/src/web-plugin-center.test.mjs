import { test, expect } from 'vitest';
import {
  WebPreviewSession,
  WebCloudTrialCreateRequest,
  WebCloudTrialProjection,
  WebCloudPreviewAction,
  PublicPluginCard,
  PublicPluginDetail,
  WebPluginCatalogQuery,
} from './web-plugin-center.ts';

test('preview session is short-lived opaque handshake data without auth tokens', () => {
  const session = WebPreviewSession.parse({
    session_id: '11111111-1111-4111-8111-111111111111',
    release_id: '22222222-2222-4222-8222-222222222222',
    release_sha256: 'a'.repeat(64),
    mode: 'CLIENT_SANDBOX',
    expires_at: '2026-07-16T00:05:00.000Z',
    channel_nonce: 'n'.repeat(32),
  });
  expect(session.mode).toBe('CLIENT_SANDBOX');
  expect(() => WebPreviewSession.parse({ ...session, auth_token: 'secret' })).toThrow();
  const target = {
    package_id: '11111111-1111-4111-8111-111111111111',
    release_id: '22222222-2222-4222-8222-222222222222',
    sha256: 'a'.repeat(64),
    action_id: 'preview',
    action_contract_version: '1.0.0',
    action_surface_sha256: 'b'.repeat(64),
  };
  expect(
    WebCloudTrialCreateRequest.parse({
      release_id: target.release_id,
      release_sha256: target.sha256,
      action_contract_version: target.action_contract_version,
      action_surface_sha256: target.action_surface_sha256,
      input: {},
      request_idempotency_key: 'request-1',
    }).request_idempotency_key
  ).toBe('request-1');
  expect(
    WebCloudTrialProjection.parse({
      invocation_id: '33333333-3333-4333-8333-333333333333',
      status: 'AUTHORIZED',
      target,
      quota_remaining: 4,
      daily_limit: 5,
      concurrency_limit: 1,
      concurrent_active: 1,
      quota_reset_at: '2026-07-17T00:00:00.000Z',
      expires_at: '2026-07-17T00:00:00.000Z',
      policy_decision_id: 'decision-1',
      output: null,
      error: null,
      created_at: '2026-07-16T00:00:00.000Z',
      started_at: null,
      completed_at: null,
    }).status
  ).toBe('AUTHORIZED');
  expect(
    WebCloudPreviewAction.parse({
      action_id: 'image.generate',
      name: '生成图片',
      description: '',
      action_contract_version: '1.0.0',
      action_surface_sha256: 'b'.repeat(64),
      input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    }).action_id
  ).toBe('image.generate');
});
import { inferMarketplaceCategory } from './marketplace-discovery.ts';

const card = {
  package_id: '11111111-1111-4111-8111-111111111111',
  listing_id: '22222222-2222-4222-8222-222222222222',
  release_id: '33333333-3333-4333-8333-333333333333',
  name: '图片生成器',
  summary: '生成图片',
  author_display_name: '作者',
  category: 'MEDIA',
  runtime_type: 'client',
  quality_tier: 'LISTED',
  version: '1.0.0',
  install_count: 10,
  rating_count: 2,
  average_rating_tenths: 45,
  base_price_cents: 990,
  price_version: 'base_opaque_token',
  preview_mode: 'STATIC_DESKTOP',
  updated_at: '2026-07-16T00:00:00.000Z',
};

test('public plugin card is a strict safe projection', () => {
  expect(PublicPluginCard.safeParse(card).success).toBe(true);
  expect(PublicPluginCard.safeParse({ ...card, manifest: { secret: true } }).success).toBe(false);
  expect(PublicPluginCard.safeParse({ ...card, price_revision: 7 }).success).toBe(false);
});

test('detail carries compatibility without exposing artifact storage fields', () => {
  const detail = PublicPluginDetail.parse({
    ...card,
    readme_markdown: '# 使用说明',
    release_sha256: 'a'.repeat(64),
    compatibility: {
      runtime_type: 'client',
      desktop_platforms: ['windows-x64'],
      minimum_desktop_version: null,
      web_compatible: false,
    },
    preview_actions: [],
  });
  expect(detail.compatibility.web_compatible).toBe(false);
  expect('artifact_key' in detail).toBe(false);
});

test('catalog query decodes stable URL filters and bounded pagination', () => {
  const query = WebPluginCatalogQuery.parse({
    q: '图片',
    category: 'MEDIA',
    page: '2',
    page_size: '12',
  });
  expect(query.page).toBe(2);
  expect(query.page_size).toBe(12);
  expect(query.sort).toBe('POPULAR');
  expect(WebPluginCatalogQuery.safeParse({ page_size: '51' }).success).toBe(false);
});

test('category inference is deterministic and conservative', () => {
  expect(inferMarketplaceCategory({ name: 'AI 代码助手', description: '对话生成代码' })).toBe('AI');
  expect(inferMarketplaceCategory({ name: '未知插件' })).toBe('OTHER');
});
