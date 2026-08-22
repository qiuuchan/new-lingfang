// 通用客户端分页常量与纯函数：插件中心、草稿页等列表共用。
// 页码从 1 起；数据缩减时页码夹紧到最后一个有效页。

/** 默认每页条数。 */
export const DEFAULT_PAGE_SIZE = 5;

/** 可选每页条数：默认 5，另提供 10/20/50 档。 */
export const PAGE_SIZE_OPTIONS = [5, 10, 20, 50] as const;

export function paginateItems<T>(items: T[], page: number, pageSize: number = DEFAULT_PAGE_SIZE) {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const totalPages = Math.max(1, Math.ceil(items.length / safePageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * safePageSize;
  return {
    currentPage,
    totalPages,
    total: items.length,
    items: items.slice(start, start + safePageSize),
  };
}
