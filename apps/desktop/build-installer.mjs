#!/usr/bin/env node
// 自制安装包构建脚本：将应用文件打包成自解压安装器。
//
// 流程：
// 1. 收集 target/release/lingfang-desktop.exe + runtimes/（B3→C 方案 C 终态：运行时随包分发）
// 2. 硬门槛：runtimes/ 必须先通过 runtime-lock.json 全量校验（keyFiles sha256 +
//    requiredFiles + materializedFiles + Playwright 漂移），否则拒绝打包
// 3. 打包为 payload.zip（排除 runtimes/.download 预取归档；内置纯净 updater.exe）
// 4. 拼接 installer.exe + payload.zip + trailer(12字节)
// 5. 输出 LingFang-Setup-{version}.exe

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWriteStream, createReadStream } from 'node:fs';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pipelineAsync = promisify(pipeline);

// MAGIC 与 Rust sfx.rs 一致
const MAGIC = Buffer.from('LFSFX\0\0\0', 'binary');
const TRAILER_LEN = 12;
// trailer 的 payload_len 为 u32 LE（与 sfx.rs 对齐）→ 单包上限 ≈4GiB。
const MAX_PAYLOAD_BYTES = 0xffffffff;

function die(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

async function main() {
  console.log('🔨 开始构建自制安装包...\n');

  const repoRoot = path.resolve(__dirname, '../..');
  const desktopRoot = path.join(repoRoot, 'apps/desktop');
  const targetRelease = path.join(repoRoot, 'target/release');

  // 读取版本号
  const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
  const version = packageJson.version;
  console.log(`📦 版本: ${version}`);

  // 1. 检查必需文件
  const appExe = path.join(targetRelease, 'lingfang-desktop.exe');
  const installerExe = path.join(targetRelease, 'installer.exe');
  const runtimesDir = path.join(desktopRoot, 'runtimes');

  if (!fs.existsSync(appExe)) {
    console.error(`❌ 应用主程序不存在: ${appExe}`);
    console.error('   请先运行: npm run build');
    process.exit(1);
  }
  if (!fs.existsSync(installerExe)) {
    console.error(`❌ 安装器不存在: ${installerExe}`);
    console.error('   请先编译: cargo build --release -p lingfang-installer');
    process.exit(1);
  }

  // 防御：待拼接的 installer 必须是裸 exe（无 payload 尾部）。
  // 若已带 LFSFX trailer，二次拼接会产出双 payload 的损坏安装器，必须在源头拒绝。
  {
    const fd = fs.openSync(installerExe, 'r');
    const tail = Buffer.alloc(TRAILER_LEN);
    fs.readSync(fd, tail, 0, TRAILER_LEN, Math.max(0, fs.fstatSync(fd).size - TRAILER_LEN));
    fs.closeSync(fd);
    if (tail.subarray(0, 8).equals(MAGIC)) {
      die('installer.exe 已含自解压尾部（疑似重复拼接）；请用干净构建产物重试');
    }
  }
  console.log('✅ 必需文件检查通过');

  // 2. B3→C（方案 C 终态）硬门槛：注入 runtimes/ 前先全量校验完整性。
  //    安装包即单一事实来源——校验不过绝不入包（sha256 与锁对齐是供应链底线）。
  if (!fs.existsSync(runtimesDir) || !fs.statSync(runtimesDir).isDirectory()) {
    console.error(`❌ 内置运行时目录不存在: ${runtimesDir}`);
    console.error('   请先灌装：下载 Release 的 runtimes-bundle.zip 解压到该目录');
    console.error('   （或按 .github/workflows/ci.yml publish-runtimes 步骤本地灌装）');
    process.exit(1);
  }
  console.log('\n🔐 校验内置运行时完整性（runtime-lock.json sha256 硬门槛）...');
  const verifyScript = path.join(repoRoot, 'scripts', 'verify-bundled-runtimes.mjs');
  const verify = spawnSync(process.execPath, [verifyScript, runtimesDir], { stdio: 'inherit' });
  if (verify.status !== 0) {
    die('runtimes/ 未通过 runtime-lock 校验——拒绝打包不完整的运行时（方案 C：安装包即真相）');
  }

  // 3. 打包 payload.zip
  const payloadZip = path.join(targetRelease, 'payload.zip');
  console.log('\n📦 打包应用文件...');

  const files = [
    { src: appExe, dst: 'lingfang-desktop.exe' },
    // 纯净 updater.exe（无 payload 尾部的裸 installer）：deploy 时优先信任它，
    // 避免「兜底复制自身」把 >1GB 的带包安装器复制进安装目录。
    { src: installerExe, dst: 'updater.exe' },
    { src: runtimesDir, dst: 'runtimes' },
  ];

  // 先创建临时目录
  const tempDir = path.join(targetRelease, 'payload-temp');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  // 复制文件到临时目录（runtimes/.download 是 CI 预取的原始归档缓存，
  // 不属于交付物，排除后可省数百 MB 冗余体积）
  for (const { src, dst } of files) {
    const target = path.join(tempDir, dst);
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, target, {
        recursive: true,
        filter: (srcPath) => path.basename(srcPath) !== '.download',
      });
    } else {
      fs.copyFileSync(src, target);
    }
  }

  // 使用 Windows 内置 tar 打包（Windows 10+ 自带，支持 zip / zip64）
  // 注意：tar 需要相对路径或 Unix 风格路径
  console.log('   使用 tar 命令打包...');
  if (fs.existsSync(payloadZip)) fs.unlinkSync(payloadZip);

  // 转换为相对路径，避免 tar 误解析 P: 为远程主机
  const relTempDir = path.relative(targetRelease, tempDir);
  const relPayloadZip = path.basename(payloadZip);

  const tarCmd = `cd "${targetRelease}" && tar -a -c -f "${relPayloadZip}" -C "${relTempDir}" .`;
  await new Promise((resolveTar, rejectTar) => {
    const child = spawnSync(tarCmd, { shell: true, stdio: 'inherit' });
    if (child.status !== 0) rejectTar(new Error(`tar 打包失败（exit=${child.status}）`));
    else resolveTar();
  });

  // 清理临时目录
  fs.rmSync(tempDir, { recursive: true, force: true });

  const payloadSize = fs.statSync(payloadZip).size;
  console.log(`✅ payload.zip 已生成 (${(payloadSize / 1024 / 1024).toFixed(1)} MB)`);

  // trailer 容量守卫：payload_len 是 u32，越界必须在此拒绝（而非产出损坏安装器）
  if (payloadSize > MAX_PAYLOAD_BYTES) {
    fs.unlinkSync(payloadZip);
    die(
      `payload ${(payloadSize / 1024 / 1024 / 1024).toFixed(2)} GiB 超过 u32 上限（≈4GiB）；` +
        '请瘦身 runtimes 或升级 trailer 格式后再打包',
    );
  }

  // 4. 拼接 installer.exe + payload.zip + trailer
  console.log('\n🔧 拼接自解压安装器...');
  const outputExe = path.join(targetRelease, `LingFang-Setup-${version}.exe`);

  // 构建 trailer
  const trailer = Buffer.alloc(TRAILER_LEN);
  MAGIC.copy(trailer, 0);
  trailer.writeUInt32LE(payloadSize, 8);

  // 写入文件
  const output = createWriteStream(outputExe);

  await pipelineAsync(createReadStream(installerExe), output, { end: false });

  await pipelineAsync(createReadStream(payloadZip), output, { end: false });

  output.write(trailer);
  output.end();

  await new Promise((resolve, reject) => {
    output.on('finish', resolve);
    output.on('error', reject);
  });

  const finalSize = fs.statSync(outputExe).size;
  console.log(`✅ 安装包已生成: ${outputExe}`);
  console.log(`   大小: ${(finalSize / 1024 / 1024).toFixed(1)} MB`);

  // 5. 清理 payload.zip
  fs.unlinkSync(payloadZip);

  console.log('\n🎉 构建完成！');
}

main().catch((err) => {
  console.error('\n❌ 构建失败:', err);
  process.exit(1);
});
