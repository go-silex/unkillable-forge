import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const headers = { version: '22.23.5', sha256: 'be890e343a72acd49e3b0491aefdc55400ed8a8fa29272d2d1ad19823e80035f' };
export const images = {
  x64: 'quay.io/pypa/manylinux_2_28_x86_64@sha256:7e41b1c7fd64dfc69703a1124b43c404382973ee06ec5d764b85c34d2221fded',
  arm64: 'quay.io/pypa/manylinux_2_28_aarch64@sha256:54b271d9562a3686298880df05367909e949ed317e7b1b79b59c696d75f78676',
};
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function sourceInputSha256() {
  const hash = createHash('sha256');
  for (const name of ['native/posix.c', 'scripts/build-native.mjs'].sort()) {
    const bytes = await readFile(join(root, name));
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`); hash.update(bytes);
  }
  return hash.digest('hex');
}
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...options }).trim();
async function main() {
  const { platform, arch } = process;
  if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported native build host');
  const ci = process.argv.includes('--ci');
  if (ci && (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'go-silex/unkillable-forge' || !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') || !/^[0-9a-f]{40}$/.test(process.env.FORGE_INPUT_SHA ?? '') || run('git', ['rev-parse', 'HEAD'], { cwd: root }) !== process.env.FORGE_INPUT_SHA)) throw new Error('Missing or mismatched CI provenance');
  const work = await mkdtemp(join(tmpdir(), 'forge-native-'));
  try {
    const response = await fetch(`https://nodejs.org/dist/v${headers.version}/node-v${headers.version}-headers.tar.gz`);
    if (!response.ok) throw new Error(`Node headers HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (sha256(archive) !== headers.sha256) throw new Error('Node headers checksum mismatch');
    const tar = join(work, 'headers.tar.gz'); await writeFile(tar, archive);
    run('tar', ['-xzf', tar, '-C', work]);
    const include = join(work, `node-v${headers.version}`, 'include', 'node');
    const output = join(work, 'posix.node');
    let compiler, target, sdk = null, osFloor, libcFloor = null;
    if (platform === 'linux' && ci) {
      const image = images[arch];
      const docker = args => run('docker', ['run', '--rm', '--network', 'none', '-v', `${root}:/source:ro`, '-v', `${work}:/work`, image, ...args]);
      compiler = `${docker(['gcc', '--version']).split('\n')[0]} (${image})`;
      target = docker(['gcc', '-dumpmachine']);
      osFloor = 'glibc-2.28'; libcFloor = '2.28';
      docker(['gcc', '-std=c11', '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=posix', '-fPIC', '-shared', '-O2', '-I', `/work/node-v${headers.version}/include/node`, '/source/native/posix.c', '-o', '/work/posix.node']);
    } else if (platform === 'linux') {
      compiler = run('cc', ['--version']).split('\n')[0];
      target = run('cc', ['-dumpmachine']);
      const glibc = run('getconf', ['GNU_LIBC_VERSION']);
      if (!/^glibc \d+\.\d+$/.test(glibc)) throw new Error('Unsupported local libc');
      libcFloor = glibc.slice(6); osFloor = `glibc-${libcFloor}`;
      run('cc', ['-std=c11', '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=posix', '-fPIC', '-shared', '-O2', '-I', include, join(root, 'native/posix.c'), '-o', output]);
    } else {
      compiler = run('clang', ['--version']).split('\n')[0];
      target = run('clang', ['-dumpmachine']);
      sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-version']);
      osFloor = '11.0';
      run('clang', ['-std=c11', '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=posix', '-dynamiclib', '-undefined', 'dynamic_lookup', '-O2', '-mmacosx-version-min=11.0', '-I', include, join(root, 'native/posix.c'), '-o', output]);
    }
    const dir = join(root, 'dist', 'native', `${platform}-${arch}`); await mkdir(dir, { recursive: true });
    const bytes = await readFile(output); await writeFile(join(dir, 'posix.node'), bytes);
    const artifact = { platform, arch, file: `${platform}-${arch}/posix.node`, sha256: sha256(bytes), sourceInputSha256: await sourceInputSha256(), nodeHeaders: headers, toolchain: { compiler, target, osFloor, libcFloor, sdk }, provenance: ci ? { kind: 'ci', repository: 'go-silex/unkillable-forge', runId: process.env.GITHUB_RUN_ID, inputSha: process.env.FORGE_INPUT_SHA } : { kind: 'local' } };
    await writeFile(join(root, 'dist', 'native', 'manifest.json'), JSON.stringify({ format: 'unkillable-forge-native', version: 1, napiVersion: 8, artifacts: [artifact] }, null, 2) + '\n');
  } finally { await rm(work, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
