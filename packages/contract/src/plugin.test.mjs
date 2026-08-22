import { test, expect } from 'vitest';
import { ErrorCode } from './llm.ts';
import { resolveGrant, Plugin, PluginManifest } from './plugin.ts';
import {
  DraftWorkspace,
  LocalPluginInstallation,
  MarketplaceListingProjection,
  PluginManagementItem,
  PluginPackageDetail,
  PluginReleaseDetail,
  PluginReleaseSummary,
  StrictSemVer,
  UpdateMarketplaceListingStatusRequest,
} from './plugin-registry.ts';
import { PluginDraft, PluginDraftStatus, PluginDraftDiagnostic } from './draft.ts';

test('all roles default to allowed when no grant matches while governance owns high-risk defaults', () => {
  expect(resolveGrant([], 'u1', 'owner')).toBe(true);
  expect(resolveGrant([], 'u1', 'admin')).toBe(true);
  expect(resolveGrant([], 'u1', 'member')).toBe(true);
});

test('deny grant still overrides owner default allow', () => {
  const grants = [
    {
      tenant_id: 't1',
      package_id: 'pkg1',
      subject_kind: 'role',
      subject_id: 'owner',
      effect: 'deny',
    },
  ];

  expect(resolveGrant(grants, 'u1', 'owner')).toBe(false);
});

test('error code contract includes backend stable codes', () => {
  for (const code of [
    'bad_request',
    'forbidden',
    'payment_required',
    'insufficient_balance',
    'upstream_llm_error',
    'internal',
  ]) {
    expect(ErrorCode.safeParse(code).success, code).toBe(true);
  }
});

// CONTRACT-04 回归：市场已发布插件（PUBLIC + ENABLED + APPROVED）必须能通过 Plugin.safeParse，
// 防止契约静默漂移回 'listed'/'disabled' 或漏掉 'public' 枚举值。
test('published marketplace plugin round-trips through Plugin schema', () => {
  const published = {
    id: 'p1',
    name: 'summarizer',
    version: '1.0.0',
    description: '示例',
    teamId: 't1',
    authorUserId: 'u1',
    runtimeType: 'CLIENT',
    entry: 'ui/index.html',
    capabilities: [],
    visibility: 'PUBLIC',
    status: 'ENABLED',
    reviewStatus: 'APPROVED',
    marketplace: true,
    priceCents: 0,
    installCount: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
  const result = Plugin.safeParse(published);
  expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
});

// CONTRACT-03 回归：桌面端实际产出的 partial/chat 状态与 diagnostics/local-cli/warn 必须通过契约。
test('plugin draft real-world values round-trip through draft schema', () => {
  expect(PluginDraftStatus.safeParse('partial').success).toBe(true);
  expect(PluginDraftStatus.safeParse('chat').success).toBe(true);
  const diag = PluginDraftDiagnostic.safeParse({
    stage: 'local-cli',
    status: 'warn',
    message: 'ok',
  });
  expect(diag.success).toBe(true);
  const draft = PluginDraft.safeParse({
    id: 'd1',
    status: 'partial',
    files: [],
    turns: [],
    diagnostics: [{ stage: 'diagnostics', status: 'warn', message: 'm' }],
  });
  expect(draft.success, JSON.stringify(draft.error?.issues)).toBe(true);
});

// CONTRACT-02 回归：PluginManifest 边界字段保持 snake_case（manifest.json 自洽），不上传时 visibility 默认 tenant。
test('PluginManifest manifest-boundary fields stay snake_case', () => {
  const manifest = PluginManifest.safeParse({
    id: ' p1 ',
    name: ' demo ',
    version: ' 0.1.0 ',
    entry: ' ui/index.html ',
    runtime_type: 'client',
  });
  expect(manifest.success, JSON.stringify(manifest.error?.issues)).toBe(true);
  expect({
    id: manifest.data.id,
    name: manifest.data.name,
    version: manifest.data.version,
    entry: manifest.data.entry,
  }).toEqual({ id: 'p1', name: 'demo', version: '0.1.0', entry: 'ui/index.html' });
});

test('PluginManifest rejects blank required fields and invalid SemVer versions', () => {
  const base = { id: 'p1', name: 'demo', version: '1.0.0', entry: 'index.html' };
  for (const field of ['id', 'name', 'version', 'entry']) {
    expect(PluginManifest.safeParse({ ...base, [field]: '   ' }).success, field).toBe(false);
  }
  for (const version of ['v1.0.0', '1.0', '01.0.0', '1.0.0-01']) {
    expect(PluginManifest.safeParse({ ...base, version }).success, version).toBe(false);
  }
});

test('PluginManifest rejects oversized metadata and capability collections', () => {
  const base = {
    id: 'p1',
    name: 'demo',
    version: '1.0.0',
    entry: 'index.html',
    runtime_type: 'client',
  };
  const atLimit = PluginManifest.parse({
    ...base,
    id: ` ${'i'.repeat(128)} `,
    name: ` ${'n'.repeat(128)} `,
    entry: ` ${'e'.repeat(512)} `,
  });
  expect(atLimit.id.length).toBe(128);
  expect(atLimit.name.length).toBe(128);
  expect(atLimit.entry.length).toBe(512);
  expect(PluginManifest.safeParse({ ...base, id: 'x'.repeat(129) }).success).toBe(false);
  expect(PluginManifest.safeParse({ ...base, name: 'x'.repeat(129) }).success).toBe(false);
  expect(PluginManifest.safeParse({ ...base, description: 'x'.repeat(4097) }).success).toBe(false);
  expect(PluginManifest.safeParse({ ...base, entry: 'x'.repeat(513) }).success).toBe(false);
  expect(
    PluginManifest.safeParse({
      ...base,
      capabilities: Array.from({ length: 65 }, () => ({ kind: 'ui.view' })),
    }).success
  ).toBe(false);
  expect(
    PluginManifest.safeParse({
      ...base,
      capabilities: [{ kind: 'ui.view', reason: 'x'.repeat(501) }],
    }).success
  ).toBe(false);
});

test('StrictSemVer accepts prereleases and rejects loose or leading-zero versions', () => {
  for (const version of ['0.1.0', '1.0.0-beta.1', '2.3.4+build.7']) {
    expect(StrictSemVer.safeParse(version).success, version).toBe(true);
  }
  for (const version of ['v1.0.0', '1.0', '01.0.0', '1.0.0-01']) {
    expect(StrictSemVer.safeParse(version).success, version).toBe(false);
  }
});

test('release, installation and draft workspace contracts keep remote and local state separate', () => {
  const manifest = {
    id: 'demo.plugin',
    name: 'Demo',
    version: '1.0.0',
    entry: 'main.py',
    runtime_type: 'python',
  };
  const release = PluginReleaseSummary.parse({
    id: '11111111-1111-4111-8111-111111111111',
    packageId: '22222222-2222-4222-8222-222222222222',
    version: '1.0.0',
    manifest,
    sha256: 'a'.repeat(64),
    sizeBytes: 1024,
    status: 'PUBLISHED',
    marketReviewStatus: 'DRAFT',
    targetPlatform: 'windows-x64',
    sourceKind: 'EXTERNAL_TOOL',
    sourceLabel: '  Cursor  ',
    ingestChannel: 'DESKTOP',
    createdAt: '2026-07-11T00:00:00.000Z',
  });
  expect('installed' in release).toBe(false);
  expect(release.sourceLabel).toBe('Cursor');

  const installation = LocalPluginInstallation.parse({
    installationId: '33333333-3333-4333-8333-333333333333',
    packageId: release.packageId,
    origin: 'team',
    activeRelease: {
      releaseId: release.id,
      version: release.version,
      sha256: release.sha256,
      path: 'installed/333/releases/111/package',
      dependencyStatus: 'pending',
    },
    pendingRelease: null,
    previousRelease: null,
    dataPath: 'installed/333/data',
    installedAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  });
  expect(installation.origin).toBe('team');

  const workspace = DraftWorkspace.parse({
    workspaceId: '44444444-4444-4444-8444-444444444444',
    title: 'Demo draft',
    path: 'workspaces/444',
    manifestId: 'demo.plugin',
    currentVersion: '1.1.0',
    runtime: 'python',
    conversationId: null,
    diagnosticStatus: 'idle',
    contentSha256: null,
    lastPublishedReleaseId: release.id,
    lastPublishedVersion: release.version,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  });
  expect(workspace.lastPublishedVersion).toBe('1.0.0');
  expect(workspace.sourceKind).toBe('UNKNOWN');
  expect(workspace.sourceLabel).toBe('');
});

test('release provenance rejects unknown enums and source labels over 80 characters', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    packageId: '22222222-2222-4222-8222-222222222222',
    version: '1.0.0',
    manifest: {
      id: 'demo.plugin',
      name: 'Demo',
      version: '1.0.0',
      entry: 'main.py',
      runtime_type: 'python',
    },
    sha256: 'a'.repeat(64),
    sizeBytes: 1024,
    status: 'PUBLISHED',
    marketReviewStatus: 'DRAFT',
    targetPlatform: 'windows-x64',
    sourceKind: 'API',
    sourceLabel: '',
    ingestChannel: 'API',
    createdAt: '2026-07-11T00:00:00.000Z',
  };
  expect(PluginReleaseSummary.safeParse({ ...base, sourceKind: 'CURSOR' }).success).toBe(false);
  expect(PluginReleaseSummary.safeParse({ ...base, ingestChannel: 'CLI' }).success).toBe(false);
  expect(PluginReleaseSummary.safeParse({ ...base, sourceLabel: 'x'.repeat(81) }).success).toBe(
    false
  );
  expect(PluginReleaseSummary.safeParse({ ...base, sourceLabel: 'VS\u0000Code' }).success).toBe(
    false
  );
});

test('exact release detail carries bounded immutable README markdown', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    packageId: '22222222-2222-4222-8222-222222222222',
    version: '1.0.0',
    manifest: {
      id: 'demo.plugin',
      name: 'Demo',
      version: '1.0.0',
      entry: 'main.py',
      runtime_type: 'python',
    },
    sha256: 'a'.repeat(64),
    sizeBytes: 1024,
    status: 'PUBLISHED',
    marketReviewStatus: 'DRAFT',
    targetPlatform: 'windows-x64',
    sourceKind: 'API',
    sourceLabel: '',
    ingestChannel: 'API',
    createdAt: '2026-07-11T00:00:00.000Z',
  };
  expect(PluginReleaseDetail.safeParse({ ...base, readme_markdown: '# Demo' }).success).toBe(true);
  expect(
    PluginReleaseDetail.safeParse({ ...base, readme_markdown: 'x'.repeat(256 * 1024 + 1) }).success
  ).toBe(false);
});

test('management and package detail contracts project listing lifecycle metadata', () => {
  const packageSummary = {
    id: '22222222-2222-4222-8222-222222222222',
    ownerTeamId: '33333333-3333-4333-8333-333333333333',
    authorUserId: '44444444-4444-4444-8444-444444444444',
    manifestId: 'demo.plugin',
    name: 'Demo',
    description: '',
    governanceStatus: 'ARCHIVED',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  };
  const listing = MarketplaceListingProjection.parse({
    status: 'DELISTED',
    currentReleaseId: null,
    priceCents: 100,
    delistedBy: 'PLATFORM',
    delistReason: 'policy',
    delistedAt: '2026-07-12T00:00:00.000Z',
    delistedByUserId: '55555555-5555-4555-8555-555555555555',
  });
  const management = PluginManagementItem.parse({
    package: packageSummary,
    latestRelease: null,
    releaseCount: 0,
    pendingReviewCount: 0,
    listing,
  });
  expect(management.listing.delistedBy).toBe('PLATFORM');
  const detail = PluginPackageDetail.parse({
    package: packageSummary,
    releases: [],
    listing,
    entitled: false,
  });
  expect(detail.package.governanceStatus).toBe('ARCHIVED');
  expect(UpdateMarketplaceListingStatusRequest.safeParse({ status: 'DRAFT' }).success).toBe(false);
  expect(
    UpdateMarketplaceListingStatusRequest.safeParse({ status: 'DELISTED', reason: 'x'.repeat(501) })
      .success
  ).toBe(false);
});
