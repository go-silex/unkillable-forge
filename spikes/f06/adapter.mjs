import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { OAuthClient } from './oauth.mjs';
import { SpikeFailure } from './errors.mjs';

const oauth = new OAuthClient(process.env.F06_RESOURCE, process.env.F06_PROFILE || '');
await oauth.load();
const mcp = new McpServer({ name: 'forge-f06-local', version: '0.0.0' });
async function fixturePath(localPath) {
  if (!process.env.F06_FIXTURE_ROOT || !isAbsolute(process.env.F06_FIXTURE_ROOT)) throw new SpikeFailure('collect', 'FIXTURE_ROOT_REQUIRED');
  const root = await realpath(process.env.F06_FIXTURE_ROOT);
  if (!(await lstat(root)).isDirectory()) throw new SpikeFailure('collect', 'FIXTURE_ROOT_INVALID');
  const lexical = relative(root, resolve(localPath));
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new SpikeFailure('collect', 'PATH_OUTSIDE_FIXTURE_ROOT');
  const target = await realpath(resolve(localPath));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new SpikeFailure('collect', 'PATH_OUTSIDE_FIXTURE_ROOT');
  return target;
}

async function collect(path, relative, files) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw Error('Symlinks are not supported');
  if (info.isDirectory()) {
    for (const name of (await readdir(path)).sort()) await collect(join(path, name), relative ? `${relative}/${name}` : name, files);
  } else if (info.isFile()) {
    if (info.size > 16 * 1024 * 1024) throw Error('File exceeds receiver limit');
    if (files.length >= 100) throw Error('Too many files');
    files.push({ path, relative: relative || basename(path), size: info.size });
  } else throw Error('Only regular files are supported');
}

async function upload(file, token, signal) {
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== file.size) throw new SpikeFailure('integrity', 'FILE_CHANGED');
    const hash = createHash('sha256');
    let size = 0;
    async function* content() {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > file.size) throw new SpikeFailure('integrity', 'FILE_GREW');
        hash.update(chunk); yield chunk;
      }
    }
    const response = await fetch(oauth.resource, { method: 'PUT', redirect: 'manual', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: Readable.toWeb(Readable.from(content())), duplex: 'half', signal });
    if (!response.ok) { await response.body?.cancel(); throw new SpikeFailure('upload', 'HTTP_ERROR', response.status); }
    const remote = await response.json();
    const localHash = hash.digest('hex');
    if (size !== file.size || remote.size !== size || remote.sha256 !== localHash) throw new SpikeFailure('integrity', 'HASH_OR_SIZE_MISMATCH');
    const identity = response.headers.get('x-f06-identity');
    if (!identity || !/^[0-9a-f]{64}$/.test(identity)) throw new SpikeFailure('integrity', 'IDENTITY_FINGERPRINT_INVALID');
    await oauth.saveIdentity(identity);
    return { path: file.relative, size, sha256: localHash };
  } finally { await handle.close(); }
}

mcp.registerTool('transfer_fixture', { description: 'Transfer a synthetic local file or directory to the authenticated temporary receiver and compare actual streamed SHA-256. No publishing.', inputSchema: { localPath: z.string().min(1), refreshOnly: z.boolean().optional() } }, async ({ localPath, refreshOnly }, { signal }) => {
  let stage = 'collect';
  try {
    const files = []; await collect(await fixturePath(localPath), '', files);
    if (!files.length) throw new SpikeFailure('collect', 'EMPTY_DIRECTORY');
    stage = 'oauth';
    const authResult = await oauth.ensure(signal, refreshOnly === true);
    stage = 'upload';
    const receipts = [];
    for (const file of files) receipts.push(await upload(file, authResult.token, signal));
    return { content: [{ type: 'text', text: JSON.stringify({ authPath: authResult.authPath, ...(authResult.refresh ? { refresh: authResult.refresh } : {}), files: receipts }) }] };
  } catch (error) {
    const failure = error instanceof SpikeFailure ? error : new SpikeFailure(stage, 'FAILED');
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ stage: failure.stage, code: failure.code, ...(failure.status ? { httpStatus: failure.status } : {}), ...(failure.oauthCode ? { oauthCode: failure.oauthCode } : {}), ...(failure.resource ? { resource: failure.resource } : {}) }) }] };
  }
});
await mcp.connect(new StdioServerTransport());
