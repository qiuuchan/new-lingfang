// PluginRunner.tsx — 插件运行器（零服务器架构）。
//
// - client 运行时：在 sandbox iframe 内渲染 entry HTML（经 read_plugin_file 读取，防穿越），
//   注入 window.sdk / window.__lingfangInvoke，把插件的能力调用经 invokeRuntime 接到 Rust 网关。
// - nodejs/python 运行时：以独立进程运行（GUI 自行弹窗），本页仅展示运行状态占位。
// - cloud/workflow 运行时：本地桌面壳不支持，渲染明确占位（需平台云）。
import { useEffect, useRef, useState } from 'react';
import type { LoadedPlugin } from '@/lib/types';
import { tauriInvoke, errorMessage } from '@/lib/api';
import { invokeRuntime } from '@/lib/plugins-runtime';
import { handleClientHostMessage } from '@/lib/pluginRunnerHost';
import { initClientActionBridge } from '@/lib/clientActionBridge';
import { registerClientActionsForPlugin } from '@/lib/clientActionRegistry';
// @ts-ignore - vite/client 提供 *.css?inline 的类型；无类型时仍由 Vite 构建期解析。
import uiTokensCss from '@lingfang/ui-tokens/tokens.css?inline';

// client iframe 内注入的 SDK 引导脚本：定义 window.__lingfangInvoke 与 window.sdk，
// 每个方法经 parent.postMessage 请求宿主能力，宿主经 invokeRuntime 触达 Rust 网关。
// 包络（envelope）与 plugin-sdk 的 sdk 对象一致（storage.kv {op}/clipboard {op}/...），
// 使 client HTML 插件与 nodejs/python 插件行为对齐。
const CLIENT_SDK_BOOTSTRAP = `(function(){
  var pending = new Map();
  var seq = 0;
  function post(kind, args){
    return new Promise(function(resolve, reject){
      var requestId = 'h' + (++seq);
      pending.set(requestId, { resolve: resolve, reject: reject });
      parent.postMessage({ __lf_host_call: true, requestId: requestId, kind: kind, args: args }, '*');
    });
  }
  window.addEventListener('message', function(event){
    var m = event.data;
    if (!m || m.__lf_host_reply !== true) return;
    var waiter = pending.get(m.requestId);
    if (!waiter) return;
    pending.delete(m.requestId);
    if (m.error) { var e = new Error(m.error.message || '能力调用失败'); e.code = m.error.code; waiter.reject(e); }
    else waiter.resolve(m.result);
  });
  window.__lingfangInvoke = post;
  var cap = post;
  var sdk = {
    storage: {
      get: function(key){ return cap('storage.kv', { op: 'get', key: key }); },
      set: function(key, value){ return cap('storage.kv', { op: 'set', key: key, value: value }); }
    },
    net: { fetch: function(input, init){ return cap('net.fetch', { url: typeof input === 'string' ? input : (input && input.url), init: init }); } },
    llm: { chat: function(input){ return cap('llm.chat', input); } },
    system: {
      info: function(){ return cap('system.info', {}); },
      screenshot: function(){ return cap('system.screenshot', {}); },
      notify: function(input){ return cap('system.notify', input); }
    },
    clipboard: {
      readText: function(){ return cap('clipboard', { op: 'read' }); },
      writeText: function(text){ return cap('clipboard', { op: 'write', text: text }); }
    },
    fs: {
      read: function(path){ return cap('fs.read', { path: path }); },
      write: function(path, content){ return cap('fs.write', { path: path, content: content }); },
      pick: function(){ return cap('fs.pick', {}); }
    },
    image: {
      generate: function(input){ return cap('image.generate', input); },
      edit: function(input){ return cap('image.edit', input); }
    },
    video: { generate: function(input){ return cap('video.generate', input); } },
    audio: { generate: function(input){ return cap('audio.generate', input); } },
    ui: { render: function(input){ return cap('ui.view', input); } },
    actions: { call: function(id, input, opts){ return cap('actions.call', { dependencyId: id, input: input, options: opts }); } },
    artifacts: {
      create: function(input){ return cap('artifacts.create', input); },
      materialize: function(input){ return cap('artifacts.materialize', input); },
      import: function(input){ return cap('artifacts.import', input); }
    },
    shared: {
      get: function(key){ return cap('shared.get', { key: key }); },
      set: function(key, value){ return cap('shared.set', { key: key, value: value }); },
      compareAndSet: function(key, value, expected){ return cap('shared.compare_and_set', { key: key, value: value, expected: expected }); },
      delete: function(key){ return cap('shared.delete', { key: key }); },
      list: function(){ return cap('shared.list', {}); }
    },
    plugin: {
      upload: function(input){ return cap('plugin.upload', input); },
      submitMarketplace: function(input){ return cap('plugin.submitMarketplace', input); }
    }
  };
  window.sdk = sdk;
})();`;

const UI_TOKENS_STYLE = `<style>${uiTokensCss}</style>`;

export function PluginRunner({
  plugin,
  onBack,
}: {
  plugin: LoadedPlugin;
  onBack: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [entryHtml, setEntryHtml] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const runtimeType = plugin.runtime_type || 'client';

  // A3：挂载时初始化 client-action 桥监听，并为本插件注册其声明的 client-action 处理器
  // （plugin-action-bridge-call → 沙箱 iframe 执行 → respond_plugin_action_bridge）。
  useEffect(() => {
    initClientActionBridge();
    void registerClientActionsForPlugin(plugin).catch(() => {
      /* 单个 action 失败已被生产者内部 console.warn 容忍 */
    });
  }, [plugin.id]);

  // A2：client 插件 → 读取 entry HTML 注入 iframe（srcdoc + sandbox，opaque origin 'null'）。
  useEffect(() => {
    if (runtimeType !== 'client') return;
    let cancelled = false;
    tauriInvoke<string>('read_plugin_file', { pluginId: plugin.id, file: plugin.entry })
      .then((html) => {
        if (!cancelled) setEntryHtml(html);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err, '插件入口读取失败'));
      });
    return () => {
      cancelled = true;
    };
  }, [plugin.id, plugin.entry, runtimeType]);

  // A2：宿主监听 iframe 的 __lf_host_call，经 invokeRuntime 转发到 Rust 网关。
  // 注意：iframe 在 entryHtml 异步读取完成后才渲染，effect 挂载时 ref 必为 null——
  // 因此监听器必须无条件注册，在事件到达时再解析 iframeRef（否则监听器永不注册，
  // 插件所有能力调用将静默挂起直到超时）。
  useEffect(() => {
    if (runtimeType !== 'client') return;
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame) return;
      handleClientHostMessage(event, {
        frame,
        pluginId: plugin.id,
        invokeRuntime,
        postReply: (reply) => frame.contentWindow?.postMessage(reply, '*'),
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [plugin.id, runtimeType]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded px-3 py-1 text-sm hover:bg-accent"
        >
          ← 返回
        </button>
        <span className="font-medium">{plugin.name}</span>
        <span className="text-sm text-muted-foreground">v{plugin.version}</span>
      </div>
      <div className="min-h-0 flex-1">
        {runtimeType === 'client' ? (
          loadError ? (
            <div className="flex h-full items-center justify-center p-6">
              <p className="text-sm text-destructive">{loadError}</p>
            </div>
          ) : entryHtml === null ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">正在加载插件…</p>
            </div>
          ) : (
            <iframe
              ref={iframeRef}
              title={plugin.name}
              sandbox="allow-scripts"
              className="h-full w-full border-0"
              srcDoc={`${UI_TOKENS_STYLE}<script>${CLIENT_SDK_BOOTSTRAP}</script>${entryHtml}`}
            />
          )
        ) : runtimeType === 'cloud' || runtimeType === 'workflow' ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <p className="text-lg font-medium">运行时类型不受本地支持</p>
              <p className="mt-2 text-sm text-muted-foreground">
                当前桌面壳仅支持 client / nodejs / python 运行时；
                <span className="font-mono">{runtimeType}</span> 需由平台云运行。
              </p>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <p className="text-lg font-medium">插件以独立进程运行</p>
              <p className="mt-2 text-sm text-muted-foreground">
                运行时：<span className="font-mono">{runtimeType}</span>
                （GUI 由插件自身窗口呈现，可在「插件」列表查看运行状态）
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
