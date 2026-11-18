import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { headers, images, root, sha256, sourceInputSha256 } from './build-native.mjs';

const check = process.argv.includes('--check');
const local = process.argv.includes('--local');
const native = join(root, 'dist/native');
const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).sort().join(',') === keys.sort().join(',');
const manifest = JSON.parse(await readFile(join(native, 'manifest.json'), 'utf8'));
if (!exact(manifest, ['format', 'version', 'napiVersion', 'artifacts']) || manifest.format !== 'unkillable-forge-native' || manifest.version !== 1 || manifest.napiVersion !== 8 || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== (local ? 1 : 4)) throw new Error('Invalid native manifest');
const seen = new Set();
let ciRun;
const input = await sourceInputSha256();
for (const a of manifest.artifacts) {
  if (!exact(a, ['platform', 'arch', 'file', 'sha256', 'sourceInputSha256', 'nodeHeaders', 'toolchain', 'provenance']) || !['linux', 'darwin'].includes(a.platform) || !['x64', 'arm64'].includes(a.arch)) throw new Error('Invalid native artifact');
  const target = `${a.platform}-${a.arch}`;
  if (seen.has(target) || a.file !== `${target}/posix.node`) throw new Error(`Invalid target ${target}`);
  seen.add(target);
  if (!/^[a-f0-9]{64}$/.test(a.sha256) || a.sourceInputSha256 !== input || !exact(a.nodeHeaders, ['version', 'sha256']) || a.nodeHeaders.version !== headers.version || a.nodeHeaders.sha256 !== headers.sha256) throw new Error(`Invalid input provenance for ${target}`);
  const localArtifact = local && a.provenance?.kind === 'local';
  const linuxFloorValid = localArtifact ? typeof a.toolchain?.libcFloor === 'string' && /^\d+\.\d+$/.test(a.toolchain.libcFloor) && a.toolchain.osFloor === `glibc-${a.toolchain.libcFloor}` : a.toolchain?.osFloor === 'glibc-2.28' && a.toolchain.libcFloor === '2.28';
  if (!exact(a.toolchain, ['compiler', 'target', 'osFloor', 'libcFloor', 'sdk']) || typeof a.toolchain.compiler !== 'string' || !a.toolchain.compiler || typeof a.toolchain.target !== 'string' || !a.toolchain.target || (a.platform === 'linux' ? !linuxFloorValid || a.toolchain.sdk !== null : a.toolchain.osFloor !== '11.0' || a.toolchain.libcFloor !== null || typeof a.toolchain.sdk !== 'string' || !a.toolchain.sdk)) throw new Error(`Invalid toolchain for ${target}`);
  if (!(local && exact(a.provenance, ['kind']) && a.provenance.kind === 'local') && (!exact(a.provenance, ['kind', 'repository', 'runId', 'inputSha']) || a.provenance.kind !== 'ci' || a.provenance.repository !== 'go-silex/unkillable-forge' || !/^\d+$/.test(a.provenance.runId) || !/^[a-f0-9]{40}$/.test(a.provenance.inputSha))) throw new Error(`Invalid CI provenance for ${target}`);
  if (a.platform === 'linux' && !localArtifact && !a.toolchain.compiler.includes(images[a.arch])) throw new Error(`Unpinned Linux toolchain for ${target}`);
  if (a.provenance.kind === 'ci') {
    const run = `${a.provenance.runId}:${a.provenance.inputSha}`;
    if (ciRun && ciRun !== run) throw new Error('Native artifacts were not produced by one source run');
    ciRun = run;
  }
  if (sha256(await readFile(join(native, a.file))) !== a.sha256) throw new Error(`Native hash mismatch for ${target}`);
}
const result = await build({
  absWorkingDir: root, entryPoints: { forge: 'src/stdio.ts', filesystem: 'src/filesystem.ts' },
  outdir: 'dist', bundle: true, splitting: true, platform: 'node', format: 'esm', target: 'node22',
  metafile: true, write: false,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const absolute = resolve(root, input);
  if (!absolute.includes('/node_modules/')) continue;
  let dir = dirname(absolute);
  while (dir.includes('/node_modules/')) {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      if (manifest.name && manifest.version) { packages.set(`${manifest.name}@${manifest.version}`, dir); break; }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    dir = dirname(dir);
  }
}
const notices = [];
for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const files = (await readdir(dir)).filter(file => /^licen[cs]e(?:\..*)?$/i.test(file)).sort();
  if (!files.length) throw new Error(`Missing license text for bundled package ${name}`);
  for (const file of files) notices.push(`${name} — ${file}\n\n${await readFile(join(dir, file), 'utf8')}`);
}
const outputs = new Map(result.outputFiles.map(file => [relative(join(root, 'dist'), file.path), file.contents]));
outputs.set('THIRD-PARTY-LICENSES.txt', Buffer.from(notices.join('\n\n---\n\n') + '\n'));
const inventory = [...outputs.keys(), 'native/manifest.json', ...manifest.artifacts.map(a => `native/${a.file}`), 'inventory.json'].sort();
outputs.set('inventory.json', Buffer.from(JSON.stringify(inventory, null, 2) + '\n'));
for (const [name, bytes] of outputs) {
  const path = join(root, 'dist', name);
  if (check) {
    if (!Buffer.from(bytes).equals(await readFile(path))) throw new Error(`Stale generated file: ${name}`);
  } else await writeFile(path, bytes);
}
async function list(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await list(join(dir, entry.name), `${name}/`));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unexpected generated entry: ${name}`);
  }
  return files;
}
const actual = (await list(join(root, 'dist'))).sort();
if (JSON.stringify(actual) !== JSON.stringify(inventory)) throw new Error(`Generated inventory mismatch: ${actual.join(', ')}`);
