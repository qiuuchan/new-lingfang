type ClientActionTerminalMessage = {
  __lf_client_action_result?: unknown;
  session_id?: unknown;
  invocation_id?: unknown;
  nonce?: unknown;
  result?: unknown;
  error?: unknown;
};

type ClientActionCallMessage = {
  __lf_client_action_call?: unknown;
  session_id?: unknown;
  invocation_id?: unknown;
  nonce?: unknown;
  request_id?: unknown;
  kind?: unknown;
  args?: unknown;
};

export type ClientActionFrameMessage = ClientActionTerminalMessage & ClientActionCallMessage;

export type ClientActionAdapterRequest = {
  invocationId: string;
  source: string;
  exportName: string;
  input: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  onCapability: (kind: string, args: unknown) => Promise<unknown>;
};

type ClientActionAdapterDependencies = {
  document: Document;
  window: Window;
  uuid: () => string;
  setTimer: typeof globalThis.setTimeout;
  clearTimer: typeof globalThis.clearTimeout;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function clientActionMessageFromFrame(
  event: MessageEvent,
  frame: HTMLIFrameElement,
  expected: { sessionId: string; invocationId: string; nonce: string }
): ClientActionFrameMessage | null {
  if (event.origin !== 'null' || event.source !== frame.contentWindow) return null;
  const message = record(event.data) as ClientActionFrameMessage | null;
  if (
    !message ||
    message.session_id !== expected.sessionId ||
    message.invocation_id !== expected.invocationId ||
    message.nonce !== expected.nonce
  )
    return null;
  if (message.__lf_client_action_call === true) {
    if (
      typeof message.request_id !== 'string' ||
      !message.request_id ||
      typeof message.kind !== 'string'
    )
      return null;
    return {
      __lf_client_action_call: true,
      session_id: expected.sessionId,
      invocation_id: expected.invocationId,
      nonce: expected.nonce,
      request_id: message.request_id,
      kind: message.kind,
      args: message.args,
    };
  }
  if (message.__lf_client_action_result === true) {
    return {
      __lf_client_action_result: true,
      session_id: expected.sessionId,
      invocation_id: expected.invocationId,
      nonce: expected.nonce,
      result: message.result,
      error: message.error,
    };
  }
  return null;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * 把受信的 ESM handler 源码转写为普通函数体：
 * - `export default <expr>` → `__exports.default = <expr>`
 * - `export const|let|var|function|async function|class <name>` → 去 export 并收集到 `__exports.<name>`
 * - `export { a, b as c }` → 收集（置空该行，单独补 __exports 赋值）
 * 其余语句原样保留。返回的函数体内置 `input` 参数与 `__exports` 对象。
 * 不依赖动态 import()，可在 opaque-origin sandbox iframe 中执行。
 */
function transformClientActionModule(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let body = '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('export ')) {
      // export { a, b as c }
      const braceMatch = line.match(/^export\s*\{([^}]*)\}\s*;?\s*$/);
      if (braceMatch) {
        for (const spec of braceMatch[1].split(',')) {
          const parts = spec.trim().split(/\s+as\s+/);
          const local = parts[0].trim();
          const exported = (parts[1] ?? parts[0]).trim();
          if (local) out.push(`__exports[${JSON.stringify(exported)}] = ${local};`);
        }
        continue;
      }
      // export default <expr>
      const defMatch = line.match(/^export\s+default\s+([\s\S]+)$/);
      if (defMatch) {
        out.push(`__exports.default = ${defMatch[1].replace(/;?\s*$/, '')};`);
        continue;
      }
      // export <decl> <name>
      const declMatch = line.match(
        /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/
      );
      if (declMatch) {
        const name = declMatch[1];
        const stripped = line.replace(/^export\s+/, '');
        out.push(`${stripped.replace(/;?\s*$/, '')};`);
        out.push(`__exports[${JSON.stringify(name)}] = ${name};`);
        continue;
      }
      // 其它 export 形态（罕见）：直接去 export 关键字保留
      out.push(line.replace(/^export\s+/, '').replace(/;?\s*$/, '') + ';');
      continue;
    }
    out.push(rawLine);
  }
  body = out.join('\n');
  return body;
}


function clientActionDocument(
  request: ClientActionAdapterRequest,
  sessionId: string,
  nonce: string,
  transformed: string
): string {
  // 关键约束：sandbox="allow-scripts" 的 opaque-origin(srcdoc) iframe 同时禁止两件事：
  //   1) new Function / eval（CSP: script-src 'self' 'unsafe-inline'，无 unsafe-eval）
  //   2) import() 动态加载 blob:/data: 模块（opaque origin 下被 Chromium 拦截）
  // 但「内联 <script type="module">」是被 'unsafe-inline' 允许的。故把经宿主预转换的
  // handler 源码（已剥离 export、收集到 __exports）作为【真实内联代码】写入 iframe，
  // 而非字符串/函数体后 eval。这样既绕开 CSP，又能执行受信的自有 plugin 源码。
  // 注意：transformed 由数组元素原样拼入（绝不进反引号模板字面量，反引号会提前终止）。
  const safe = transformed.replace(/<\/(script)/gi, '<\\/$1');
  const lines: string[] = [
    '<!doctype html><meta charset="utf-8"><script type="module">',
    'const sessionId = ' + scriptJson(sessionId) + ';',
    'const invocationId = ' + scriptJson(request.invocationId) + ';',
    'const nonce = ' + scriptJson(nonce) + ';',
    'const exportName = ' + scriptJson(request.exportName) + ';',
    'const input = ' + scriptJson(request.input) + ';',
    'let sequence = 0;',
    'const pending = new Map();',
    'addEventListener("message", (event) => {',
    '  if (event.source !== parent) return;',
    '  const message = event.data;',
    '  if (!message || message.__lf_client_action_reply !== true || message.session_id !== sessionId || message.invocation_id !== invocationId || message.nonce !== nonce) return;',
    '  const waiter = pending.get(message.request_id);',
    '  if (!waiter) return;',
    '  pending.delete(message.request_id);',
    "  if ('error' in message) waiter.reject(Object.assign(new Error(message.error?.message || '宿主能力调用失败'), message.error || {}));",
    '  else waiter.resolve(message.result);',
    '});',
    'globalThis.__lingfangInvoke = (kind, args) => new Promise((resolve, reject) => {',
    '  const requestId = String(++sequence);',
    '  pending.set(requestId, { resolve, reject });',
    '  parent.postMessage({ __lf_client_action_call: true, session_id: sessionId, invocation_id: invocationId, nonce, request_id: requestId, kind, args }, "*");',
    '});',
    'let __exports = {};',
    safe,
    'try {',
    '  let handler = __exports;',
    '  for (const part of exportName.split(".")) handler = handler?.[part];',
    '  if (typeof handler !== "function") throw new Error("Client Action handler export 不存在");',
    '  const result = await handler(input);',
    '  parent.postMessage({ __lf_client_action_result: true, session_id: sessionId, invocation_id: invocationId, nonce, result }, "*");',
    '} catch (error) {',
    '  parent.postMessage({ __lf_client_action_result: true, session_id: sessionId, invocation_id: invocationId, nonce, error: { name: error?.name || "Error", message: error?.message || String(error), code: error?.code } }, "*");',
    '}',
    '<\/script>',
  ];
  return lines.join('\n');
}

export function executeClientActionAdapter(
  request: ClientActionAdapterRequest,
  overrides: Partial<ClientActionAdapterDependencies> = {}
): Promise<Record<string, unknown>> {
  const deps: ClientActionAdapterDependencies = {
    document: overrides.document ?? globalThis.document,
    window: overrides.window ?? globalThis.window,
    uuid: () => crypto.randomUUID(),
    setTimer: globalThis.setTimeout.bind(globalThis),
    clearTimer: globalThis.clearTimeout.bind(globalThis),
    ...overrides,
  };
  const sessionId = deps.uuid();
  const nonce = deps.uuid();
  const frame = deps.document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.display = 'none';
  frame.srcdoc = clientActionDocument(
    request,
    sessionId,
    nonce,
    transformClientActionModule(request.source)
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let loadCount = 0;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const seenRequests = new Set<string>();
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) deps.clearTimer(timer);
      deps.window.removeEventListener('message', onMessage);
      frame.removeEventListener('load', onLoad);
      request.signal?.removeEventListener('abort', onAbort);
      frame.remove();
      callback();
    };
    const fail = (error: Error) => finish(() => reject(error));
    const onAbort = () =>
      fail(Object.assign(new Error('Client Action 已取消'), { code: 'action_cancelled' }));
    const onLoad = () => {
      loadCount += 1;
      if (loadCount > 1)
        fail(
          Object.assign(new Error('Client Action frame 导航后已失效'), {
            code: 'action_execution_failed',
          })
        );
    };
    const onMessage = (event: MessageEvent) => {
      const message = clientActionMessageFromFrame(event, frame, {
        sessionId,
        invocationId: request.invocationId,
        nonce,
      });
      if (!message || settled) return;
      if (message.__lf_client_action_call === true) {
        const requestId = String(message.request_id);
        if (seenRequests.has(requestId)) return;
        seenRequests.add(requestId);
        const reply = (payload: Record<string, unknown>) =>
          frame.contentWindow?.postMessage(
            {
              __lf_client_action_reply: true,
              session_id: sessionId,
              invocation_id: request.invocationId,
              nonce,
              request_id: requestId,
              ...payload,
            },
            '*'
          );
        if (
          ![
            'actions.call',
            'artifacts.create',
            'artifacts.materialize',
            'artifacts.import',
            // A3：扩展 client-action 可合法声明的子集，避免合法 kind 被 action_dependency_denied 卡死。
            'ui.view',
            'storage.kv',
          ].includes(String(message.kind))
        ) {
          reply({
            error: {
              code: 'action_dependency_denied',
              message: `Client Action 不允许调用能力：${String(message.kind)}`,
            },
          });
          return;
        }
        void request.onCapability(String(message.kind), message.args).then(
          (result) => reply({ result }),
          (error) => {
            const source = record(error);
            reply({
              error: {
                name: source?.name,
                message: source?.message || String(error),
                code: source?.code,
                status: source?.status,
                requestId: source?.requestId,
              },
            });
          }
        );
        return;
      }
      if (message.error !== undefined) {
        const source = record(message.error);
        fail(
          Object.assign(
            new Error(
              typeof source?.message === 'string' ? source.message : 'Client Action 执行失败'
            ),
            {
              name: typeof source?.name === 'string' ? source.name : 'Error',
              code: typeof source?.code === 'string' ? source.code : 'action_execution_failed',
            }
          )
        );
        return;
      }
      const output = record(message.result);
      if (!output) {
        fail(
          Object.assign(new Error('Client Action output 必须是 JSON 对象'), {
            code: 'action_output_invalid',
          })
        );
        return;
      }
      finish(() => resolve(output));
    };
    timer = deps.setTimer(
      () => fail(Object.assign(new Error('Client Action 执行超时'), { code: 'action_timeout' })),
      Math.max(1, request.timeoutMs)
    );
    deps.window.addEventListener('message', onMessage);
    frame.addEventListener('load', onLoad);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) {
      onAbort();
      return;
    }
    (deps.document.body ?? deps.document.documentElement).appendChild(frame);
  });
}
