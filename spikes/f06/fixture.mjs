import { mkdir, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = process.argv[2];
if (!root || process.argv.length !== 3) throw Error('Provide one new fixture directory outside the repository');
const dest = resolve(root);
await mkdir(dest, { recursive: false, mode: 0o700 });
await mkdir(join(dest, 'assets'), { mode: 0o700 });
const f = await open(join(dest, 'index.html'), 'wx', 0o600);
try {
  await f.write('<!doctype html><link rel="stylesheet" href="assets/style.css"><img src="assets/pixel.svg"><!--\n');
  const chunk = 'synthetic-forge-fixture-0123456789\n'.repeat(2048);
  for (let i = 0; i < 64; i++) await f.write(chunk);
  await f.write('--><h1>F06 synthetic fixture</h1>\n');
} finally { await f.close(); }
await writeFile(join(dest, 'assets/style.css'), 'h1 { color: navy }\n', { flag: 'wx', mode: 0o600 });
await writeFile(join(dest, 'assets/pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>\n', { flag: 'wx', mode: 0o600 });
console.log('Synthetic fixture created.');
