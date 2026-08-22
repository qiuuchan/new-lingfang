import * as React from 'react';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';

type ButtonProps = React.ComponentProps<typeof Button>;

// 带加载态的按钮：loading 时禁用并显示旋转图标。
export function LoadingButton({
  loading,
  children,
  disabled,
  ...props
}: ButtonProps & { loading?: boolean }) {
  return (
    <Button disabled={disabled || loading} {...props}>
      {loading && <Loader2Icon className="size-4 animate-spin" />}
      {children}
    </Button>
  );
}
