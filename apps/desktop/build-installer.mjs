#!/usr/bin/env node
// 自制安装包构建脚本：将应用文件打包成自解压安装器。
//
// 流程：
// 1. 收集 target/release/lingfang-desktop.exe + runtimes/
// 2. 打包为 payload.zip
// 3. 拼接 installer.exe + payload.zip + trailer(12字节)
// 4. 输出 LingFang-Setup-{version}.exe

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream, createReadStream } from 'node:fs';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream';
import { exec } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pipelineAsync = promisify(pipeline);
const execAsync = promisify(exec);

// MAGIC 与 Rust sfx.rs 一致
const MAGIC = Buffer.from('LFSFX\0\0\0', 'binary');
const TRAILER_LEN = 12;

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
    console.error('   请先编译: cd installer && cargo build --release');
    process.exit(1);
  }
  console.log('✅ 必需文件检查通过');

  // 2. 打包 payload.zip
  const payloadZip = path.join(targetRelease, 'payload.zip');
  console.log('\n📦 打包应用文件...');

  // 使用 7z 或 tar 打包（Node.js 没有内置 zip）
  const files = [
    { src: appExe, dst: 'lingfang-desktop.exe' },
    { src: runtimesDir, dst: 'runtimes' },
  ];

  // 先创建临时目录
  const tempDir = path.join(targetRelease, 'payload-temp');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  // 复制文件到临时目录
  for (const { src, dst } of files) {
    const target = path.join(tempDir, dst);
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, target, { recursive: true });
    } else {
      fs.copyFileSync(src, target);
    }
  }

  // 使用 Windows 内置 tar 打包（Windows 10+ 自带，支持 zip）
  // 注意：tar 需要相对路径或 Unix 风格路径
  console.log('   使用 tar 命令打包...');
  if (fs.existsSync(payloadZip)) fs.unlinkSync(payloadZip);

  // 转换为相对路径，避免 tar 误解析 P: 为远程主机
  const relTempDir = path.relative(targetRelease, tempDir);
  const relPayloadZip = path.basename(payloadZip);

  const tarCmd = `cd "${targetRelease}" && tar -a -c -f "${relPayloadZip}" -C "${relTempDir}" .`;
  await execAsync(tarCmd, { shell: 'cmd.exe' });

  // 清理临时目录
  fs.rmSync(tempDir, { recursive: true, force: true });

  const payloadSize = fs.statSync(payloadZip).size;
  console.log(`✅ payload.zip 已生成 (${(payloadSize / 1024 / 1024).toFixed(1)} MB)`);

  // 3. 拼接 installer.exe + payload.zip + trailer
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

  // 4. 清理 payload.zip
  fs.unlinkSync(payloadZip);

  console.log('\n🎉 构建完成！');
}

main().catch((err) => {
  console.error('\n❌ 构建失败:', err);
  process.exit(1);
});
