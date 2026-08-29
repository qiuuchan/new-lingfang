// 管理后台通用基元（分页元数据、分页包装器、用户摘要）。
// 这些是 admin 领域的共享基础设施，被 plugin-registry 等核心模块复用，
// 因此留在 @qianxia/contract；平台云专属的 admin-governance 业务形状
// （QX-09 / H1 已迁出 @qianxia/platform-contract）从这里复用这些基元。
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
