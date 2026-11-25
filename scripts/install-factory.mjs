import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACTORY_EXECUTABLE, FACTORY_VERSION, factoryBinaryPath } from '../lib/factory-release.mjs';

const releases = {
  'win32-x64': ['factory-windows-x86_64.zip', '539ca9bdb0c52d6cdb806012652d88451a4647dce4bc2841d2224184e999bf18'],
  'linux-x64': ['factory-linux-x86_64.tar.gz', 'f619e05b64cbb3eeb2fc123dd8e379bdc3530934038ff4f758b82366b2177180'],
  'darwin-x64': ['factory-macos-x86_64.tar.gz', '1e81a2593cbe34dd6a8cedfeaf9efc14de67627068e0cbd6a8bd3f696ac35fed'],
  'darwin-arm64': ['factory-macos-aarch64.tar.gz', 'ee917b6edb22422285a9d0b5856989ce10dddaec3f0a549c38cd6829d8ba1516'],
};
const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = data => createHash('sha256').update(data).digest('hex');

async function install(args) {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--archive' || !args[1])) {
    throw new Error('用法 npm run factory:install [-- --archive <官方发布包路径>]');
  }
  const asset = releases[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error('当前系统架构没有 Factory v1.0.5 官方预编译包。');
  const [name, digest] = asset;
  let bytes;
  if (args.length) bytes = await readFile(path.resolve(args[1]));
  else {
    const url = `https://github.com/OmegaMc1331/agentic-software-factory/releases/download/v${FACTORY_VERSION}/${name}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`下载 Factory 发布包失败，HTTP ${response.status}。`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (sha256(bytes) !== digest) throw new Error('Factory 发布包的 SHA-256 与锁定版本不一致。');
  const binary = factoryBinaryPath(root), directory = path.dirname(binary);
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(path.join(directory, '.install-'));
  try {
    const archive = path.join(staging, name);
    await writeFile(archive, bytes);
    for (const member of ['LICENSE', FACTORY_EXECUTABLE]) {
      const result = spawnSync('tar', ['-xOf', archive, member], {
        windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
      });
      if (result.status !== 0 || !result.stdout?.length) throw new Error(`无法从已校验发布包读取 ${member}，请检查 tar。`);
      const target = path.join(staging, member);
      await writeFile(target, result.stdout, { mode: member === FACTORY_EXECUTABLE ? 0o755 : 0o644 });
      await rename(target, path.join(directory, member));
    }
    console.log(`Factory v${FACTORY_VERSION} 已安装至 ${binary}`);
  } finally {
    if (path.dirname(staging) === directory && path.basename(staging).startsWith('.install-')) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

install(process.argv.slice(2)).catch(error => {
  console.error(`[Factory] ${error.message}`);
  process.exitCode = 1;
});
