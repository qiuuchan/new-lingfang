import { z } from 'zod';
import { AdminUserSummary, createAdminPageSchema } from './admin-governance.ts';
import { PluginManifest, RuntimeType } from './plugin.ts';
import { StrictSemVer } from './semver.ts';

export { StrictSemVer } from './semver.ts';

export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, 'sha256 must be lowercase hexadecimal');
export type Sha256Hex = z.infer<typeof Sha256Hex>;

export const PluginPackageGovernanceStatus = z.enum(['ACTIVE', 'ARCHIVED']);
export const PluginReleaseStatus = z.enum(['PUBLISHED', 'YANKED']);
export const PluginReleaseReviewStatus = z.enum(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED']);
export const PluginAiPolicyStatus = z.enum(['UNCHECKED', 'PASSED', 'FAILED']);
export type PluginAiPolicyStatus = z.infer<typeof PluginAiPolicyStatus>;
export const MarketplaceListingStatus = z.enum(['DRAFT', 'ACTIVE', 'DELISTED']);
export const PluginReleaseSourceKind = z.enum([
  'LINGFANG_CREATOR',
  'EXTERNAL_TOOL',
  'LOCAL_ARTIFACT',
  'COPIED_INSTALLATION',
  'API',
  'LEGACY_MIGRATION',
  'UNKNOWN',
]);
export type PluginReleaseSourceKind = z.infer<typeof PluginReleaseSourceKind>;

export const PluginIngestChannel = z.enum(['DESKTOP', 'API', 'MIGRATION']);
export type PluginIngestChannel = z.infer<typeof PluginIngestChannel>;

export const MarketplaceDelistActor = z.enum(['OWNER', 'PLATFORM']);
export type MarketplaceDelistActor = z.infer<typeof MarketplaceDelistActor>;

export const PluginReleaseSourceLabel = z
  .string()
  .trim()
  .refine((value) => [...value].length <= 80, {
    message: 'sourceLabel must not exceed 80 characters',
  })
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'sourceLabel must not contain control characters',
  });
export type PluginReleaseSourceLabel = z.infer<typeof PluginReleaseSourceLabel>;

export const PluginPackageSummary = z.object({
  id: z.string().uuid(),
  ownerTeamId: z.string().uuid(),
  authorUserId: z.string().uuid().nullable(),
  manifestId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  governanceStatus: PluginPackageGovernanceStatus,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PluginPackageSummary = z.infer<typeof PluginPackageSummary>;

export const PluginReleaseSummary = z.object({
  id: z.string().uuid(),
  packageId: z.string().uuid(),
  version: StrictSemVer,
  manifest: PluginManifest,
  package_policy_surface_sha256: Sha256Hex.default('0'.repeat(64)),
  sha256: Sha256Hex,
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(300 * 1024 * 1024),
  status: PluginReleaseStatus,
  marketReviewStatus: PluginReleaseReviewStatus,
  targetPlatform: z.literal('windows-x64'),
  sourceKind: PluginReleaseSourceKind,
  sourceLabel: PluginReleaseSourceLabel,
  ingestChannel: PluginIngestChannel,
  aiPolicyVersion: z.number().int().nonnegative().default(0),
  aiPolicyStatus: PluginAiPolicyStatus.default('UNCHECKED'),
  aiPolicyReason: z.string().max(1000).default(''),
  createdAt: z.string().datetime(),
});
export type PluginReleaseSummary = z.infer<typeof PluginReleaseSummary>;

export const PluginReleaseDetail = PluginReleaseSummary.extend({
  readme_markdown: z
    .string()
    .max(256 * 1024)
    .default(''),
});
export type PluginReleaseDetail = z.infer<typeof PluginReleaseDetail>;

export const MarketplaceListingProjection = z.object({
  status: MarketplaceListingStatus,
  currentReleaseId: z.string().uuid().nullable(),
  priceCents: z.number().int().nonnegative(),
  delistedBy: MarketplaceDelistActor.nullable(),
  delistReason: z.string().max(500),
  delistedAt: z.string().datetime().nullable(),
  delistedByUserId: z.string().uuid().nullable(),
});
export type MarketplaceListingProjection = z.infer<typeof MarketplaceListingProjection>;

export const PluginManagementItem = z.object({
  package: PluginPackageSummary,
  latestRelease: PluginReleaseSummary.nullable(),
  releaseCount: z.number().int().nonnegative(),
  pendingReviewCount: z.number().int().nonnegative(),
  listing: MarketplaceListingProjection.nullable(),
});
export type PluginManagementItem = z.infer<typeof PluginManagementItem>;

export const PluginPackageDetail = z.object({
  package: PluginPackageSummary,
  releases: z.array(PluginReleaseSummary),
  listing: MarketplaceListingProjection.nullable(),
  entitled: z.boolean(),
});
export type PluginPackageDetail = z.infer<typeof PluginPackageDetail>;

export const UpdatePluginPackageStatusRequest = z.object({
  status: PluginPackageGovernanceStatus,
});
export type UpdatePluginPackageStatusRequest = z.infer<typeof UpdatePluginPackageStatusRequest>;

export const UpdatePluginReleaseStatusRequest = z.object({
  status: PluginReleaseStatus,
});
export type UpdatePluginReleaseStatusRequest = z.infer<typeof UpdatePluginReleaseStatusRequest>;

export const PluginRuntimeAccessRequest = z.object({
  releaseId: z.string().min(1),
  sha256: Sha256Hex,
});
export type PluginRuntimeAccessRequest = z.infer<typeof PluginRuntimeAccessRequest>;

export const UpdateMarketplaceListingStatusRequest = z.object({
  status: z.enum(['ACTIVE', 'DELISTED']),
  reason: z.string().max(500).optional(),
});
export type UpdateMarketplaceListingStatusRequest = z.infer<
  typeof UpdateMarketplaceListingStatusRequest
>;

export const PluginLifecycleReasonRequest = z.object({
  reason: z.string().max(500).optional(),
});
export type PluginLifecycleReasonRequest = z.infer<typeof PluginLifecycleReasonRequest>;

export const AdminPluginOwnerTeamSummary = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    slug: z.string().min(1),
  })
  .strict();
export type AdminPluginOwnerTeamSummary = z.infer<typeof AdminPluginOwnerTeamSummary>;

export const AdminPluginReleaseSummary = z
  .object({
    id: z.string().uuid(),
    version: StrictSemVer,
    status: PluginReleaseStatus,
    marketReviewStatus: PluginReleaseReviewStatus,
    sourceKind: PluginReleaseSourceKind,
    sourceLabel: PluginReleaseSourceLabel,
    ingestChannel: PluginIngestChannel,
    aiPolicyVersion: z.number().int().nonnegative().default(0),
    aiPolicyStatus: PluginAiPolicyStatus.default('UNCHECKED'),
    aiPolicyReason: z.string().max(1000).default(''),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminPluginReleaseSummary = z.infer<typeof AdminPluginReleaseSummary>;

const AdminPluginListingBase = {
  priceCents: z.number().int().nonnegative(),
  delistedBy: MarketplaceDelistActor.nullable(),
  delistReason: z.string().max(500),
  delistedAt: z.string().datetime().nullable(),
  delistedByUserId: z.string().uuid().nullable(),
};

export const AdminPluginListingProjection = z.discriminatedUnion('status', [
  z
    .object({
      ...AdminPluginListingBase,
      status: z.literal('ACTIVE'),
      currentReleaseId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...AdminPluginListingBase,
      status: z.literal('DRAFT'),
      currentReleaseId: z.null(),
    })
    .strict(),
  z
    .object({
      ...AdminPluginListingBase,
      status: z.literal('DELISTED'),
      currentReleaseId: z.string().uuid().nullable(),
    })
    .strict(),
]);
export type AdminPluginListingProjection = z.infer<typeof AdminPluginListingProjection>;

export const AdminPluginPackageListItem = z
  .object({
    id: z.string().uuid(),
    manifestId: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    governanceStatus: PluginPackageGovernanceStatus,
    ownerTeam: AdminPluginOwnerTeamSummary,
    listing: AdminPluginListingProjection.nullable(),
    latestRelease: AdminPluginReleaseSummary.nullable(),
    marketplaceCurrentVersion: StrictSemVer.nullable(),
    releaseCount: z.number().int().nonnegative(),
    pendingReviewCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AdminPluginPackageListItem = z.infer<typeof AdminPluginPackageListItem>;

export const AdminPluginPackagePage = createAdminPageSchema(AdminPluginPackageListItem);
export type AdminPluginPackagePage = z.infer<typeof AdminPluginPackagePage>;

export const AdminPluginPackageOverview = PluginPackageSummary.strict();
export type AdminPluginPackageOverview = z.infer<typeof AdminPluginPackageOverview>;

export const AdminPluginPackageDetail = z
  .object({
    package: AdminPluginPackageOverview,
    ownerTeam: AdminPluginOwnerTeamSummary,
    listing: AdminPluginListingProjection.nullable(),
    releaseCount: z.number().int().nonnegative(),
    pendingReviewCount: z.number().int().nonnegative(),
  })
  .strict();
export type AdminPluginPackageDetail = z.infer<typeof AdminPluginPackageDetail>;

export const AdminPluginReleaseListItem = AdminPluginReleaseSummary.extend({
  targetPlatform: z.literal('windows-x64'),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(300 * 1024 * 1024),
  isMarketplaceCurrent: z.boolean(),
}).strict();
export type AdminPluginReleaseListItem = z.infer<typeof AdminPluginReleaseListItem>;

export const AdminPluginReleasePage = createAdminPageSchema(AdminPluginReleaseListItem);
export type AdminPluginReleasePage = z.infer<typeof AdminPluginReleasePage>;

export const AdminPluginReleaseCore = z
  .object({
    id: z.string().uuid(),
    packageId: z.string().uuid(),
    version: StrictSemVer,
    sha256: Sha256Hex,
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(300 * 1024 * 1024),
    targetPlatform: z.literal('windows-x64'),
    status: PluginReleaseStatus,
    marketReviewStatus: PluginReleaseReviewStatus,
    reviewReason: z.string(),
    reviewedById: z.string().uuid().nullable(),
    reviewedAt: z.string().datetime().nullable(),
    sourceKind: PluginReleaseSourceKind,
    sourceLabel: PluginReleaseSourceLabel,
    ingestChannel: PluginIngestChannel,
    aiPolicyVersion: z.number().int().nonnegative().default(0),
    aiPolicyStatus: PluginAiPolicyStatus.default('UNCHECKED'),
    aiPolicyReason: z.string().max(1000).default(''),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminPluginReleaseCore = z.infer<typeof AdminPluginReleaseCore>;

export const AdminPluginReleaseCoreDetail = z
  .object({
    release: AdminPluginReleaseCore,
    listing: AdminPluginListingProjection.nullable(),
    isMarketplaceCurrent: z.boolean(),
  })
  .strict();
export type AdminPluginReleaseCoreDetail = z.infer<typeof AdminPluginReleaseCoreDetail>;

export const AdminPluginReleaseManifest = z
  .object({
    releaseId: z.string().uuid(),
    manifest: PluginManifest,
  })
  .strict();
export type AdminPluginReleaseManifest = z.infer<typeof AdminPluginReleaseManifest>;

export const AdminPluginReleaseFile = z
  .object({
    path: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type AdminPluginReleaseFile = z.infer<typeof AdminPluginReleaseFile>;

export const AdminPluginReleaseFilePage = createAdminPageSchema(AdminPluginReleaseFile);
export type AdminPluginReleaseFilePage = z.infer<typeof AdminPluginReleaseFilePage>;

export const AdminPluginReleaseReview = z
  .object({
    id: z.string().uuid(),
    status: PluginReleaseReviewStatus,
    reason: z.string(),
    reviewer: AdminUserSummary.nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminPluginReleaseReview = z.infer<typeof AdminPluginReleaseReview>;

export const AdminPluginReleaseReviewPage = createAdminPageSchema(AdminPluginReleaseReview);
export type AdminPluginReleaseReviewPage = z.infer<typeof AdminPluginReleaseReviewPage>;

export const PluginCatalogItem = z.object({
  package: PluginPackageSummary,
  latestRelease: PluginReleaseSummary,
  priceCents: z.number().int().nonnegative().optional(),
  listPriceCents: z.number().int().nonnegative().optional(),
  discountAmountCents: z.number().int().nonnegative().optional(),
  priceVersion: z
    .string()
    .regex(/^pv1\.[A-Za-z0-9_-]{43}$/)
    .optional(),
  listingStatus: MarketplaceListingStatus.optional(),
  entitled: z.boolean().optional(),
  /** v4 discovery projection; optional for clients talking to an older API. */
  category: z
    .enum(['AI', 'PRODUCTIVITY', 'DEV', 'DATA', 'MEDIA', 'FILES', 'NETWORK', 'SYSTEM', 'OTHER'])
    .optional(),
  qualityTier: z.enum(['LISTED', 'QUALITY', 'FEATURED']).optional(),
  qualityQualifiedAt: z.string().datetime().nullable().optional(),
});
export type PluginCatalogItem = z.infer<typeof PluginCatalogItem>;

export const PluginEntitlement = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  packageId: z.string().uuid(),
  kind: z.literal('PURCHASED'),
  purchaseId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type PluginEntitlement = z.infer<typeof PluginEntitlement>;

export const LocalPluginOrigin = z.enum(['builtin', 'local', 'team', 'marketplace']);
export const DependencyPreparationStatus = z.enum(['pending', 'preparing', 'ready', 'failed']);

export const LocalPluginReleaseRef = z.object({
  releaseId: z.string().min(1),
  version: StrictSemVer,
  sha256: Sha256Hex,
  path: z.string().min(1),
  dependencyStatus: DependencyPreparationStatus,
});

export const LocalPluginInstallation = z.object({
  installationId: z.string().uuid(),
  packageId: z.string().min(1),
  origin: LocalPluginOrigin,
  protected: z.boolean().default(false),
  activeRelease: LocalPluginReleaseRef,
  pendingRelease: LocalPluginReleaseRef.nullable(),
  previousRelease: LocalPluginReleaseRef.nullable(),
  dataPath: z.string().min(1),
  installedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LocalPluginInstallation = z.infer<typeof LocalPluginInstallation>;

export const DraftDiagnosticStatus = z.enum(['idle', 'checking', 'ready', 'warning', 'error']);
export const DraftWorkspace = z.object({
  workspaceId: z.string().uuid(),
  title: z.string().min(1),
  path: z.string().min(1),
  manifestId: z.string().min(1),
  currentVersion: StrictSemVer,
  runtime: RuntimeType,
  sourceKind: PluginReleaseSourceKind.default('UNKNOWN'),
  sourceLabel: PluginReleaseSourceLabel.default(''),
  conversationId: z.string().nullable(),
  diagnosticStatus: DraftDiagnosticStatus,
  contentSha256: Sha256Hex.nullable(),
  lastPublishedReleaseId: z.string().uuid().nullable(),
  lastPublishedVersion: StrictSemVer.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DraftWorkspace = z.infer<typeof DraftWorkspace>;
