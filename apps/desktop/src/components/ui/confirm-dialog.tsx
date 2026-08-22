// confirm-dialog.tsx —— 可复用的确认对话框（基于 base-ui Dialog 封装）。
//
// 替代浏览器原生 window.confirm（在 WebView 里样式简陋、不贴合平台风格），
// 提供标题 + 描述 + 取消/确认按钮（确认支持 destructive 变体用于删除等不可逆操作）。
//
// 用法（受控）：
//   const [open, setOpen] = useState(false);
//   <ConfirmDialog
//     open={open}
//     onOpenChange={setOpen}
//     title="确定删除草稿吗？"
//     description="此操作不可撤销。"
//     confirmText="删除"
//     destructive
//     onConfirm={() => doDelete()}
//   />
import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 确认按钮用 destructive 样式（删除等不可逆操作）。 */
  destructive?: boolean;
  /** 确认中禁用按钮（异步操作时传 true）。 */
  busy?: boolean;
  /** 点确认时执行；可为 async。执行后由调用方决定是否关闭（通常在 finally 里 onOpenChange(false)）。 */
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  destructive = false,
  busy = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelText}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
