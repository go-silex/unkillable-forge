import { readFile } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

export type NativeClient = 'claude-code' | 'codex' | 'omp';
export interface InstanceProfile {
  schemaVersion: 1;
  profileId: string;
  instanceId: string;
  readOrigin: string;
  manageOrigin: string;
  mcpResource: string;
  approvedAuthorizationIssuer: string;
  approvedEndpointOrigin: string;
  roots: readonly { id: string; absolutePath: string }[];
  authProfile: string;
}

function url(value: unknown, originOnly: boolean): string {
  if (typeof value !== 'string') throw new Error('INVALID_PROFILE');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('INVALID_PROFILE'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || (originOnly && parsed.pathname !== '/')) throw new Error('INVALID_PROFILE');
  return originOnly ? parsed.origin : value;
}

export function validateProfile(value: unknown): InstanceProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_PROFILE');
  const p = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'profileId', 'instanceId', 'readOrigin', 'manageOrigin', 'mcpResource', 'approvedAuthorizationIssuer', 'approvedEndpointOrigin', 'roots', 'authProfile'];
  if (Object.keys(p).some(k => !keys.includes(k)) || p.schemaVersion !== 1) throw new Error('INVALID_PROFILE');
  const identifier = (x: unknown): string => {
    if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(x)) throw new Error('INVALID_PROFILE');
    return x;
  };
  const readOrigin = url(p.readOrigin, true), manageOrigin = url(p.manageOrigin, true);
  const mcpResource = url(p.mcpResource, false);
  const approvedAuthorizationIssuer = url(p.approvedAuthorizationIssuer, false);
  const approvedEndpointOrigin = url(p.approvedEndpointOrigin, true);
  if (readOrigin === manageOrigin || mcpResource !== `${manageOrigin}/mcp` || new URL(approvedAuthorizationIssuer).origin !== approvedEndpointOrigin) throw new Error('INVALID_PROFILE');
  if (!Array.isArray(p.roots) || !p.roots.length) throw new Error('INVALID_PROFILE');
  const seen = new Set<string>();
  const roots = p.roots.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('INVALID_PROFILE');
    const r = entry as Record<string, unknown>;
    if (Object.keys(r).some(k => k !== 'id' && k !== 'absolutePath')) throw new Error('INVALID_PROFILE');
    const id = identifier(r.id);
    if (seen.has(id) || typeof r.absolutePath !== 'string' || !isAbsolute(r.absolutePath) || normalize(r.absolutePath) !== r.absolutePath) throw new Error('INVALID_PROFILE');
    seen.add(id);
    return { id, absolutePath: r.absolutePath };
  });
  return { schemaVersion: 1, profileId: identifier(p.profileId), instanceId: identifier(p.instanceId), readOrigin, manageOrigin, mcpResource, approvedAuthorizationIssuer, approvedEndpointOrigin, roots, authProfile: identifier(p.authProfile) };
}

export async function loadProfile(path: string): Promise<InstanceProfile> {
  if (!isAbsolute(path)) throw new Error('INVALID_PROFILE_PATH');
  try { return validateProfile(JSON.parse(await readFile(path, 'utf8'))); } catch { throw new Error('INVALID_PROFILE'); }
}
