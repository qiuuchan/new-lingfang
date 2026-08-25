import { z } from 'zod';
import { AdminPaginationMetadata, createAdminPageSchema, AdminUserSummary } from '@lingfang/contract';

export { AdminPaginationMetadata, createAdminPageSchema, AdminUserSummary } from '@lingfang/contract';

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
