// PluginLaunchScreen.tsx — 统一插件启动中转页的「启动中」视觉（任务 06-25）。
//
// 四类运行时（client/nodejs/python/cloud）启动都先经过统一中转页：
//   启动中（本组件）→ 成功进入插件本体 / 失败显示 ErrorBubble。
// 脚本类(nodejs/python)的分阶段进度由 ScriptPreviewPanel 的 StartProgressView 承担（带 checking/
// deps_installing/starting 步骤）；本组件用于 client(HTML 文档加载) 与 cloud(入口准备) 的轻量启动态，
// 提供与脚本类一致的「正在启动 <插件名>…」视觉语言，让所有插件启动体验统一。
import { Loader2Icon } from 'lucide-react';

export function PluginLaunchScreen({ pluginName, hint }: { pluginName: string; hint?: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <Loader2Icon className="size-8 animate-spin text-primary" />
        <h3 className="text-base font-medium">正在启动 {pluginName}…</h3>
        <p className="text-sm text-muted-foreground">{hint || '插件即将就绪，请稍候。'}</p>
      </div>
    </div>
  );
}
