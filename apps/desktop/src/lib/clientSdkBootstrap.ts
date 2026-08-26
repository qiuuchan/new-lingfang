// clientSdkBootstrap.ts — 注入 client iframe 的 SDK 引导脚本（模板字符串，eval 在插件沙箱内）。
//
// 定义 window.__lingfangInvoke 与 window.sdk：每个方法经 parent.postMessage 请求宿主能力，
// 宿主（pluginRunnerHost.ts）经 invokeRuntime 触达 Rust 网关。
// 包络（envelope）与 plugin-sdk 的 sdk 对象一致（storage.kv {op}/clipboard {op}/...），
// 使 client HTML 插件与 nodejs/python 插件行为对齐。
//
// ⚠️ 本门面须与 packages/plugin-sdk/src/index.ts 的 sdk 对象保持同步——LF-07 曾只改 npm SDK
// 与本 shim 漏同步（iframe 内 storage.list 不存在），真机 e2e 才暴露（LF-12 验收）。
// 回归测试见 clientSdkBootstrap.spec.ts。
export const CLIENT_SDK_BOOTSTRAP = `(function(){
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
      set: function(key, value){ return cap('storage.kv', { op: 'set', key: key, value: value }); },
      // LF-07 管理 API（list 解包 keys / count 解包 count / delete 回传 {deleted}，与 npm SDK 门面一致）。
      list: function(prefix){ return cap('storage.kv', prefix !== undefined ? { op: 'list', prefix: prefix } : { op: 'list' }).then(function(r){ return r.keys; }); },
      delete: function(key){ return cap('storage.kv', { op: 'delete', key: key }); },
      count: function(){ return cap('storage.kv', { op: 'count' }).then(function(r){ return r.count; }); }
    },
    net: { fetch: function(input, init){ return cap('net.fetch', { url: typeof input === 'string' ? input : (input && input.url), init: init }); } },
    llm: { chat: function(input){ return cap('llm.chat', input); } },
    system: {
      info: function(){ return cap('system.info', {}); },
      screenshot: function(){ return cap('system.screenshot', {}); },
      // 与 plugin-sdk 门面签名对齐：notify(title, body?)，而非单 input 对象。
      notify: function(title, body){ return cap('system.notify', { title: title, body: body }); }
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
