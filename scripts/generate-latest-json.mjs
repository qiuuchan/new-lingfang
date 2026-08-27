#!/usr/bin/env node
// generate-latest-json.mjs — 发版流水线生成更新 feed `latest.json`（LF-16）。
//
// 字段契约的唯一权威是 update.rs 的 Feed/FeedSetup 解析结构（见 ADR
// docs/decisions/update-feed-source.md）：多余字段会被 serde 忽略，缺失必需字段
// （version / setup.url）则应用侧解析直接失败——所以本脚本只产出契约内字段。
//
// 用法：
//   node scripts/generate-latest-json.mjs --tag v0.1.12 \
//     --setup target/release/LingFang-Setup-0.1.12.exe [--repo owner/name] \
//     [--notes "修复…"] [--pub-date <ISO>] [--out latest.json]
//   node scripts/generate-latest-json.mjs --emit-fixture   # 输出固定样本（CI drift guard 用）
//
// 校验（硬门槛，任一不符即 exit 1）：
//   tag 与安装包文件名中的版本必须一致；--check-app-version 传入时再与
//   apps/desktop/package.json 的 version 一致（三处同源才允许发版）。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`[generate-latest-json] ❌ ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    if (name === 'emit-fixture') {
      args['emit-fixture'] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = value;
      i++;
    }
  }
  return args;
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function versionFromTag(tag) {
  const v = String(tag ?? '').replace(/^v/, '');
  if (!VERSION_RE.test(v)) fail(`tag 版本号非法：${tag}（期望 vX.Y.Z 形态，严格 semver）`);
  return v;
}

function readAppVersion() {
  const pkg = path.join(REPO_ROOT, 'apps', 'desktop', 'package.json');
  return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
}

/** 构造 feed 对象。键序即序列化顺序（与 Rust 契约阅读顺序一致，保持产物稳定）。 */
function buildFeed({ version, setupUrl, minisigUrl, sha256, size, notes, pubDate }) {
  return {
    version,
    notes,
    pub_date: pubDate,
    setup: {
      url: setupUrl,
      sha256,
      minisig_url: minisigUrl,
      size,
    },
  };
}

function serialize(feed) {
  // 固定 2 空格缩进 + 尾换行；JSON.stringify 键序跟插入序（buildFeed 已固定）。
  return `${JSON.stringify(feed, null, 2)}\n`;
}

function emitFixture() {
  // 样本完全自包含：不依赖任何文件字节，sha256 对固定常量字符串计算——
  // CI drift guard 因此可跨平台逐字节复现。fixture 的 url/version 等取
  // 「下一版」形态值，仅供解析层测试与漂移防护，不代表真实发布参数。
  const fixturePubDate = '2026-01-01T00:00:00.000Z';
  const sha = createHash('sha256').update('lingfang-latest-json-fixture-sample-bytes').digest('hex');
  const feed = buildFeed({
    version: '99.0.0',
    setupUrl:
      'https://github.com/qiuuchan/new-lingfang/releases/download/v99.0.0/LingFang-Setup-99.0.0.exe',
    minisigUrl:
      'https://github.com/qiuuchan/new-lingfang/releases/download/v99.0.0/LingFang-Setup-99.0.0.exe.minisig',
    sha256: sha,
    size: 123456789,
    notes: '',
    pubDate: fixturePubDate,
  });
  process.stdout.write(serialize(feed));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['emit-fixture']) {
    emitFixture();
    return;
  }

  if (!args.tag) fail('缺少 --tag vX.Y.Z');
  if (!args.setup || typeof args.setup !== 'string') fail('缺少 --setup <LingFang-Setup-*.exe 路径>');

  const repo = typeof args.repo === 'string' && args.repo ? args.repo : process.env.GITHUB_REPOSITORY || 'qiuuchan/new-lingfang';
  const version = versionFromTag(args.tag);

  const setupPath = path.resolve(args.setup);
  if (!fs.existsSync(setupPath)) fail(`安装包不存在：${setupPath}`);

  const base = path.basename(setupPath);
  const fileVersion = base.match(/LingFang-Setup-(.+)\.exe$/)?.[1];
  if (!fileVersion) fail(`安装包文件名不符合 LingFang-Setup-{version}.exe 形态：${base}`);
  if (fileVersion !== version) {
    fail(`tag 版本 (${version}) 与安装包文件名版本 (${fileVersion}) 不一致`);
  }
  if (
    args['check-app-version'] === true ||
    typeof args['check-app-version'] === 'string'
  ) {
    const appVersion = readAppVersion();
    if (appVersion !== version) {
      fail(`tag 版本 (${version}) 与 apps/desktop/package.json 版本 (${appVersion}) 不一致`);
    }
  }

  const bytes = fs.readFileSync(setupPath);
  if (bytes.length === 0) fail('安装包为空，拒绝生成 feed');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const notes = typeof args.notes === 'string' ? args.notes : '';
  const pubDate =
    typeof args['pub-date'] === 'string' && args['pub-date'] ? args['pub-date'] : new Date().toISOString();

  const encodedTag = encodeURIComponent(args.tag);
  const feed = buildFeed({
    version,
    setupUrl: `https://github.com/${repo}/releases/download/${encodedTag}/${base}`,
    minisigUrl: `https://github.com/${repo}/releases/download/${encodedTag}/${base}.minisig`,
    sha256,
    size: bytes.length,
    notes,
    pubDate,
  });

  const text = serialize(feed);
  if (typeof args.out === 'string' && args.out) {
    fs.writeFileSync(path.resolve(args.out), text);
    console.log(
      `[generate-latest-json] ✔ ${path.resolve(args.out)}（${version}，size=${bytes.length}，sha256=${sha256.slice(0, 12)}…）`,
    );
  } else {
    process.stdout.write(text);
  }
}

main();
