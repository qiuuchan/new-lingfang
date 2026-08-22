import { z } from 'zod';

export const AdminPaginationMetadata = z
  .object({
    total: z.number().int().nonnegative(),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
  })
  .strict();
export type AdminPaginationMetadata = z.infer<typeof AdminPaginationMetadata>;

export function createAdminPageSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z
    .object({
      items: z.array(itemSchema),
      ...AdminPaginationMetadata.shape,
    })
    .strict();
}

export type AdminPage<T> = AdminPaginationMetadata & { items: T[] };

export const AdminUserSummary = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().min(1),
  })
  .strict();
export type AdminUserSummary = z.infer<typeof AdminUserSummary>;

export const TeamAdminApplicationStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED']);
export type TeamAdminApplicationStatus = z.infer<typeof TeamAdminApplicationStatus>;

export const TeamAdminApplicationSummary = z
  .object({
    id: z.string().uuid(),
    teamName: z.string().min(1),
    status: TeamAdminApplicationStatus,
    createdAt: z.string().datetime(),
    user: AdminUserSummary,
  })
  .strict();
export type TeamAdminApplicationSummary = z.infer<typeof TeamAdminApplicationSummary>;

export const TeamAdminApplicationPage = createAdminPageSchema(TeamAdminApplicationSummary);
export type TeamAdminApplicationPage = z.infer<typeof TeamAdminApplicationPage>;

export const TeamAdminApplicationDetail = TeamAdminApplicationSummary.extend({
  reason: z.string(),
  reviewReason: z.string(),
  reviewedAt: z.string().datetime().nullable(),
  reviewedBy: AdminUserSummary.nullable(),
}).strict();
export type TeamAdminApplicationDetail = z.infer<typeof TeamAdminApplicationDetail>;

export const TeamAdminApplicationDetailResponse = z
  .object({
    application: TeamAdminApplicationDetail,
  })
  .strict();
export type TeamAdminApplicationDetailResponse = z.infer<typeof TeamAdminApplicationDetailResponse>;

export const AdminGovernanceReason = z.string().trim().min(1).max(500);
export type AdminGovernanceReason = z.infer<typeof AdminGovernanceReason>;

export const AdminRejectReasonRequest = z
  .object({
    reason: AdminGovernanceReason,
  })
  .strict();
export type AdminRejectReasonRequest = z.infer<typeof AdminRejectReasonRequest>;

export const AdminDelistReasonRequest = z
  .object({
    reason: AdminGovernanceReason,
  })
  .strict();
export type AdminDelistReasonRequest = z.infer<typeof AdminDelistReasonRequest>;
