import { useEffect, type ReactNode } from 'react';
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useTransform,
  useReducedMotion,
  animate,
  type Variants,
  type HTMLMotionProps,
} from 'framer-motion';
import { cn } from '@/lib/utils';

/* 动画基建（组D / framer-motion）：集中提供可复用的入场、交错、数字滚动、骨架闪光、页面转场组件。
   与 apps/collab-admin/src/lib/motion.tsx 共享同一套语义（组件名 / 行为一致），便于双端维护对齐。
   全部尊重 prefers-reduced-motion：系统开启「减少动态效果」时退化为静态渲染或瞬时切换，避免引起眩晕。
   设计要点：
   - 入场类组件（FadeIn/SlideIn/Stagger*）用 useReducedMotion 提前分流，关闭动效时直接返回普通 div，零成本降级。
   - AnimatedNumber 用 useMotionValue + animate() 驱动数值从 0 滚到目标值，useTransform 把数值格式化为展示字符串。
   - PageTransition 供 App.tsx 在 view 切换时做淡入/位移转场（home 常驻挂载的 PluginCreatorHome 除外）。 */

/** 方向 → 初始位移：up/down 控制 y 轴，left/right 控制 x 轴。 */
type Direction = 'up' | 'down' | 'left' | 'right';

/** framer-motion 入场动画时长（秒）。集中定义便于「整体调慢且观感一致」。
   与 index.css 的 --lf-dur-* CSS 变量是两套机制（CSS 变量供 Tailwind 工具类，这里供 framer-motion 数字 duration）。
   入场类整体偏慢（约 ×1.4~1.5）；AnimatedNumber/Shimmer 属持续/循环类，单列且不随入场调慢以免拖沓。 */
export const MOTION = {
  fadeIn: 0.2,
  slideIn: 0.25,
  item: 0.2,
  stagger: 0.08,
  delayChildren: 0.06,
  page: 0.15,
  pageReduce: 0.1,
  menu: 0.25,
} as const;

const DIRECTION_OFFSET: Record<Direction, { x?: number; y?: number }> = {
  up: { y: 24 },
  down: { y: -24 },
  left: { x: -24 },
  right: { x: 24 },
};

/** 淡入 + 轻微上浮，适合区块标题、卡片等单元素入场。 */
export function FadeIn({
  children,
  delay = 0,
  duration = MOTION.fadeIn,
  className,
}: {
  children: ReactNode;
  delay?: number;
  duration?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration, delay, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}

/** 方向感知的滑入。direction 决定从哪一侧进入（默认 up：自下而上）。 */
export function SlideIn({
  children,
  direction = 'up',
  delay = 0,
  duration = MOTION.slideIn,
  className,
}: {
  children: ReactNode;
  direction?: Direction;
  delay?: number;
  duration?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, ...DIRECTION_OFFSET[direction] }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration, delay, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}

/** 交错容器：子级用 StaggerItem 包裹，按 stagger 间隔依次入场。
 *  通过 variants 的 staggerChildren 机制驱动，子级无需自己声明 initial/animate。 */
const CONTAINER_VARIANTS: Variants = {
  hidden: {},
  show: (ctx: { stagger: number; delayChildren: number }) => ({
    transition: { staggerChildren: ctx.stagger, delayChildren: ctx.delayChildren },
  }),
};

const ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: MOTION.item, ease: 'easeOut' } },
};

export function StaggerContainer({
  children,
  className,
  stagger = MOTION.stagger,
  delayChildren = MOTION.delayChildren,
}: {
  children: ReactNode;
  className?: string;
  stagger?: number;
  delayChildren?: number;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      custom={{ stagger, delayChildren }}
      variants={CONTAINER_VARIANTS}
      initial="hidden"
      animate="show"
    >
      {children}
    </motion.div>
  );
}

/** 交错项：必须作为 StaggerContainer 的直接子级。
 *  whileHover 用于挂载时的入场与悬停反馈（如卡片上浮）二者叠加，互不冲突。 */
export function StaggerItem({
  children,
  className,
  whileHover,
}: {
  children: ReactNode;
  className?: string;
  whileHover?: HTMLMotionProps<'div'>['whileHover'];
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div className={className} variants={ITEM_VARIANTS} whileHover={whileHover}>
      {children}
    </motion.div>
  );
}

/** 数字滚动：值从 0 平滑动画到目标值。
 *  - value 必须是数字（余额传 cents、百分比传 0-100 整数）。
 *  - format 可选，把中间帧数值格式化为展示串（如 (v) => `¥${(v/100).toFixed(2)}`）。
 *  - 未传 format 时按简体中文千分位取整展示。 */
export function AnimatedNumber({
  value,
  format,
  duration = 1.2,
  className,
}: {
  value: number;
  format?: (latest: number) => string;
  duration?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const count = useMotionValue(0);
  const display = useTransform(count, (latest) =>
    format ? format(latest) : Math.round(latest).toLocaleString('zh-CN')
  );

  useEffect(() => {
    if (reduce) {
      // 关闭动效：直接置为目标值，避免停留在 0。
      count.set(value);
      return;
    }
    const controls = animate(count, value, { duration, ease: 'easeOut' });
    return () => controls.stop();
  }, [value, duration, reduce, count]);

  return <motion.span className={className}>{display}</motion.span>;
}

/** 骨架闪光块：加载占位。用 motion.div 循环平移一道高光横扫，模拟内容加载中的 shimmer。
 *  高光用 foreground/10 透明度，自动适配亮/暗主题。供 Suspense fallback 与列表加载态复用。 */
export function Shimmer({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  if (reduce) {
    return <div className={cn('rounded-md bg-muted/60', className)} />;
  }
  return (
    <div className={cn('relative overflow-hidden rounded-md bg-muted/60', className)}>
      <motion.div
        className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/10 to-transparent"
        initial={{ x: '-100%' }}
        animate={{ x: '100%' }}
        transition={{ duration: 1.6, repeat: Infinity, ease: 'linear' }}
      />
    </div>
  );
}

/** 列表骨架占位：渲染 count 行 Shimmer，宽度递减模拟内容节奏。
 *  用于列表加载态（Plugins/Market/Review 等）与 Suspense fallback。 */
export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Shimmer key={i} className={cn('h-12 w-full', i === rows - 1 ? 'w-2/3' : '')} />
      ))}
    </div>
  );
}

/** 页面切换转场：AnimatePresence + motion.div，子级按 viewKey 切换时 fade only。
 *  mode="wait" 保证旧视图退出后再挂载新视图，避免双视图同时撑开布局。
 *  仅 App.tsx 的视图容器使用（PluginCreatorHome 常驻挂载，不进此组件）。 */
export function PageTransition({
  viewKey,
  children,
  className,
}: {
  viewKey: string;
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={viewKey}
        className={className}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduce ? MOTION.pageReduce : MOTION.page, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
