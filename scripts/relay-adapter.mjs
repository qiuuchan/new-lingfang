#!/usr/bin/env node
// relay-adapter.mjs — 本地 relay 适配器（QX-04b 官方模型商路径）。
//
// 背景：千匣桌面壳把 llm.chat 等调用转发到「平台 relay」协议
//（POST {api_base}/api/relay/v1/chat/completions，model=fast|premium，
//  Authorization: Bearer <token>）。本仓库零服务器、不含该 relay；
// 本脚本在本机扮演这个 relay，把请求转发给任意 OpenAI 兼容官方模型商。
//
// 安全边界：
//   - 只监听 127.0.0.1（环回），绝不绑定 0.0.0.0；
//   - 上游 API key 只经环境变量注入，绝不打日志、绝不写入任何文件；
//   - 客户端发来的 Bearer token 不转发给上游（上游用自己的 key）；
//   - 日志只含路径/状态码/耗时，不含任何头与 body。
//
// 用法：
//   RELAY_ADAPTER_UPSTREAM_KEY=sk-xxx \
//   RELAY_ADAPTER_UPSTREAM_BASE=https://api.deepseek.com \
//   RELAY_ADAPTER_MODEL_FAST=deepseek-chat \
//   RELAY_ADAPTER_MODEL_PREMIUM=deepseek-reasoner \
//   HTTPS_PROXY=http://127.0.0.1:7897 \        # 可选；不设则直连上游
//   node scripts/relay-adapter.mjs             # 默认监听 http://127.0.0.1:8787
//
// 配合桌面壳：QIANXIA_RELAY_API_BASE=http://127.0.0.1:8787
// QIANXIA_RELAY_TOKEN=<任意非空值> 跑 scripts/e2e-relay-verify.mjs。
//
// 协议细节对齐 apps/desktop/src-tauri/src/plugin_llm_bridge.rs：
//   - relay_response_json 解析错误体 {code, message, requestId, details.upstreamDetail}
//   - extract_chat_content 从 OpenAI 形状 choices[0].message.content 抽取文本

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.RELAY_ADAPTER_PORT ?? 8787);
const HOST = '127.0.0.1';
const UPSTREAM_BASE = (process.env.RELAY_ADAPTER_UPSTREAM_BASE ?? 'https://api.deepseek.com').replace(/\/+$/, '');
const UPSTREAM_KEY = process.env.RELAY_ADAPTER_UPSTREAM_KEY?.trim();
const MODEL_FAST = process.env.RELAY_ADAPTER_MODEL_FAST?.trim() || 'deepseek-chat';
const MODEL_PREMIUM = process.env.RELAY_ADAPTER_MODEL_PREMIUM?.trim() || 'deepseek-reasoner';
const PROXY = (process.env.HTTPS_PROXY || process.env.http_proxy || '').trim();
const MOCK = process.env.RELAY_ADAPTER_MOCK === '1';
// KB 演示模式（QX-20）：与 MOCK 的「链路标识语」不同，返回一条自然的本地知识库回答，
// 供 README Demo GIF / 截图使用（无 key、可复现）。仅影响 /chat/completions。
const MOCK_KB = process.env.RELAY_ADAPTER_MOCK_KB === '1';

if (!UPSTREAM_KEY && !MOCK && !MOCK_KB) {
  console.error('[relay-adapter] ✗ 缺少 RELAY_ADAPTER_UPSTREAM_KEY（官方模型商 API key），拒绝启动');
  process.exit(1);
}
if (!UPSTREAM_BASE.startsWith('https://')) {
  console.error('[relay-adapter] ✗ 上游地址必须是 https（当前：' + UPSTREAM_BASE + '）');
  process.exit(1);
}

function log(msg) {
  console.log(`[relay-adapter] ${msg}`);
}

// ── 上游调用：直连或经 HTTP CONNECT 隧道（Node 原生 fetch 无代理支持，手写） ──

function upstreamRequest(method, pathname, bodyJson, headers, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const target = new URL(UPSTREAM_BASE);
    const reqPath = pathname.startsWith('/') ? pathname : '/' + pathname;
    const finish = (socket) => {
      const req = https.request({
        hostname: target.hostname,
        port: target.port || 443,
        path: reqPath,
        method,
        headers,
        createConnection: () => socket,
        servername: target.hostname,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('upstream timeout')));
      if (bodyJson != null) req.write(bodyJson);
      req.end();
    };

    if (PROXY) {
      const proxyUrl = new URL(PROXY.startsWith('http://') ? PROXY : 'http://' + PROXY);
      const connectReq = http.request({
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port) || 7897,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
        headers: { Host: `${target.hostname}:${target.port || 443}` },
      });
      connectReq.on('connect', (_res, socket) => {
        if (_res.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`代理 CONNECT 失败：HTTP ${_res.statusCode}`));
          return;
        }
        const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => finish(tlsSocket));
        tlsSocket.on('error', reject);
      });
      connectReq.on('error', reject);
      connectReq.setTimeout(15_000, () => connectReq.destroy(new Error('代理连接超时')));
      connectReq.end();
    } else {
      finish(tls.connect({ host: target.hostname, port: target.port || 443, servername: target.hostname }));
    }
  });
}

function jsonError(status, code, message, requestId, upstreamDetail) {
  const body = { code, message, requestId };
  if (upstreamDetail) body.details = { upstreamDetail };
  return { status, body };
}

const server = http.createServer((req, res) => {
  const requestId = req.headers['x-request-id'] || randomUUID();
  const started = Date.now();
  const done = (status, body) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : JSON.stringify(body));
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'X-Request-Id': requestId,
    });
    res.end(buf);
    log(`${req.method} ${req.url} -> ${status} (${Date.now() - started}ms)`);
  };

  if (req.method === 'POST' && req.url === '/api/relay/v1/chat/completions') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return done(400, jsonError(400, 'bad_request', '请求体不是有效 JSON', requestId));
      }
      const messages = Array.isArray(body.messages) && body.messages.length > 0 ? body.messages : null;
      if (!messages) return done(400, jsonError(400, 'bad_request', '缺少 messages', requestId));
      const tier = body.model === 'premium' ? 'premium' : body.model === 'fast' ? 'fast' : null;
      if (!tier) return done(400, jsonError(400, 'unsupported_model', 'model 仅支持 fast 或 premium', requestId));
      const model = tier === 'premium' ? MODEL_PREMIUM : MODEL_FAST;

      // mock 模式：不调上游，返回带标识的 OpenAI 形状响应（用于无 key/无网络时验证全链路）。
      if (MOCK) {
        const mockText = `【MOCK·本地适配器】你请求的是 ${tier}/${model}，共 ${messages.length} 条消息。链路已通：桌面壳 → 本地 relay 适配器 → 回传。`;
        return done(200, {
          id: `mock-${requestId}`,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: mockText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }

      // KB 演示模式（QX-20）：返回自然语言回答（内容与 kb-station 演示文档一致），
      // 不泄露 MOCK 标识，供 README 真机截图/GIF 复现。
      if (MOCK_KB) {
        const mockKbText =
          '根据本地知识库检索到的片段：千匣台是一个零服务器的 Tauri v2 桌面插件平台。' +
          '插件在本地桌面壳中运行，所有特权调用都要经过能力网关检查；' +
          '客户端插件运行在沙箱 iframe 中，无法触达宿主页面与 Tauri IPC；' +
          'nodejs 与 python 进程插件是普通操作系统进程，真实防线是安装时信任（minisign 验签）。';
        return done(200, {
          id: `mockkb-${requestId}`,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: mockKbText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }

      try {
        const up = await upstreamRequest('POST', '/chat/completions', JSON.stringify({
          model,
          messages,
          stream: false,
        }), {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${UPSTREAM_KEY}`,
        });
        let parsed;
        try {
          parsed = JSON.parse(up.body || '{}');
        } catch {
          return done(502, jsonError(502, 'relay_response_invalid', '上游响应不是有效 JSON', requestId, up.body.slice(0, 500)));
        }
        if (up.status >= 200 && up.status < 300) {
          // 原样透传 OpenAI 形状响应（extract_chat_content 读取 choices[0].message.content）
          return done(up.status, parsed);
        }
        const upMsg = parsed?.error?.message || `上游 HTTP ${up.status}`;
        return done(up.status >= 500 ? 502 : up.status,
          jsonError(up.status >= 500 ? 'upstream_llm_error' : 'relay_error', '上游模型服务错误', requestId, upMsg));
      } catch (e) {
        return done(502, jsonError(502, 'upstream_llm_error', '无法连接上游模型服务', requestId, String(e.message || e)));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/relay/v1/models') {
    return done(200, { models: [{ id: MODEL_FAST }, { id: MODEL_PREMIUM }] });
  }

  // ── 图像生成（QX-12 scope #3）：确定性伪响应，对齐 SDK { images: string[] } ──
  if (req.method === 'POST' && req.url === '/api/relay/v1/images/generations') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch {
        return done(400, jsonError(400, 'bad_request', '请求体不是有效 JSON', requestId));
      }
      if (!body.prompt || String(body.prompt).trim() === '') {
        return done(400, jsonError(400, 'bad_request', '缺少 prompt', requestId));
      }
      if (MOCK) {
        // 确定性伪图（1x1 PNG 前缀），验证全链路用。
        return done(200, { data: [{ url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC' }] });
      }
      return done(501, jsonError(501, 'not_implemented', '本地适配器非 MOCK 模式不支持图像生成上游转发', requestId));
    });
    return;
  }

  // ── 图像编辑（QX-12 scope #3）：与生成同形，标记 EDITED ──
  if (req.method === 'POST' && req.url === '/api/relay/v1/images/edits') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch {
        return done(400, jsonError(400, 'bad_request', '请求体不是有效 JSON', requestId));
      }
      if (!body.prompt || String(body.prompt).trim() === '') {
        return done(400, jsonError(400, 'bad_request', '缺少 prompt', requestId));
      }
      if (MOCK) {
        return done(200, { data: [{ url: 'data:image/png;base64,EDITED' }] });
      }
      return done(501, jsonError(501, 'not_implemented', '本地适配器非 MOCK 模式不支持图像编辑上游转发', requestId));
    });
    return;
  }

  // ── 视频生成（QX-12 scope #3）：确定性伪响应，对齐 SDK 透传 {
  //    task_id, call_log_id, charged, credits } ──
  if (req.method === 'POST' && req.url === '/api/relay/v1/videos/generations') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch {
        return done(400, jsonError(400, 'bad_request', '请求体不是有效 JSON', requestId));
      }
      if (!body.image || String(body.image).trim() === '') {
        return done(400, jsonError(400, 'bad_request', '缺少 image(base64)', requestId));
      }
      if (MOCK) {
        return done(200, { task_id: 'mock-task-' + requestId, call_log_id: 'mock-call-' + requestId, charged: true, credits: 1 });
      }
      return done(501, jsonError(501, 'not_implemented', '本地适配器非 MOCK 模式不支持视频生成上游转发', requestId));
    });
    return;
  }

  // ── 音频生成（QX-12 scope #3）：确定性伪响应，对齐 SDK { audio: string } ──
  if (req.method === 'POST' && req.url === '/api/relay/v1/audio/generations') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch {
        return done(400, jsonError(400, 'bad_request', '请求体不是有效 JSON', requestId));
      }
      if (!body.prompt_text || String(body.prompt_text).trim() === '') {
        return done(400, jsonError(400, 'bad_request', '缺少 prompt_text', requestId));
      }
      if (MOCK) {
        // 确定性伪音频（最小合法 WAV 前缀），验证全链路用。
        return done(200, { audio: 'data:audio/wav;base64,UklGRgAAAAAIAAAAAAA=' });
      }
      return done(501, jsonError(501, 'not_implemented', '本地适配器非 MOCK 模式不支持音频生成上游转发', requestId));
    });
    return;
  }

  done(404, jsonError(404, 'not_found', '本地适配器仅支持 /api/relay/v1/chat/completions、/api/relay/v1/models、/api/relay/v1/images/generations、/api/relay/v1/images/edits、/api/relay/v1/videos/generations、/api/relay/v1/audio/generations', requestId));
});

server.listen(PORT, HOST, () => {
  log(`本地 relay 适配器就绪：http://${HOST}:${PORT}`);
  if (MOCK) {
    log('MOCK 模式：不调上游，返回带标识的假响应（验证链路用）。');
  } else {
    log(`上游：${UPSTREAM_BASE}（fast -> ${MODEL_FAST}，premium -> ${MODEL_PREMIUM}）`);
    log(`代理：${PROXY || '无（直连上游）'}`);
    log('模型商 API key 仅存于本进程环境，不落盘、不打日志。');
  }
});
