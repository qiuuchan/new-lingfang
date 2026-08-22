// PanelDialog.tsx — 通用功能悬浮窗（项 14）：Dialog + 标题 + 可滚动内容区。
//
// 替代原 AccountDialog 的聚合 tab：团队钱包 / 设置 / 个人资料 等功能各自一个
// PanelDialog 实例，从 AvatarMenu 对应按钮打开。承载既有页面组件（TeamWallet /
// Settings 等），不在本组件内放业务逻辑——只提供统一的浮窗外壳（标题栏 + 拖拽 + 滚动）。
import { type ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { dragRegionProps } from '@/lib/window-drag';

export function PanelDialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  children,
  size = 'lg',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
  /** lg = 大（设置/团队管理等多内容）；md = 中（钱包/团队空间）；sm = 小（固定矮窗）；
   *  auto = 高度随内容自适应（个人资料：内容短，避免固定高导致底部大片留白）。 */
  size?: 'lg' | 'md' | 'sm' | 'auto';
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'flex flex-col gap-0 overflow-hidden p-0',
          size === 'lg'
            ? 'h-[86vh] max-h-[86vh] w-[94vw] sm:max-w-6xl'
            : size === 'md'
              ? 'h-[80vh] max-h-[80vh] w-[90vw] sm:max-w-2xl'
              : size === 'auto'
                ? 'max-h-[80vh] w-[88vw] sm:max-w-xl'
                : 'h-[60vh] max-h-[60vh] w-[88vw] sm:max-w-xl'
        )}
      >
        <DialogHeader className="border-b px-5 py-4" {...dragRegionProps}>
          <DialogTitle className="flex items-center gap-2" data-tauri-drag-region>
            {icon}
            {title}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-5">{children}</div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
