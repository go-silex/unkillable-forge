// Synthetic values for local workerd tests only; not production limits or credentials.
export const manageHttpBindings: Record<string, string> = {
  FORGE_INSTANCE: JSON.stringify({ instanceId: "test-forge", canonicalHost: "forge.example.test", aliasHosts: ["alias.example.test"], manageHost: "manage.example.test", accessTeamDomain: "team.cloudflareaccess.com", readAudiences: ["reader"], manageAudiences: ["manager"], login: "serve-shell", routeGrammars: ["tree", "subtree"], shareGrammars: ["page", "card", "slug"], shareCookie: true, shellPaths: ["/", "/login"] }),
  FORGE_SHARE_VERIFIER_KEYS: JSON.stringify([{ kid: "one", key: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ" }]),
  FORGE_PUBLICATION_OPTIONS: JSON.stringify({ sessionTtlMs: 60000, maxUploadTimeoutMs: 5000, retainMs: 900000, marginMs: 5000, manageClockSkewMs: 0, readClockSkewMs: 0 }),
  FORGE_MANAGE_TRANSPORT: JSON.stringify({ maxCommandBytes: 32768, commandReadTimeoutMs: 100, maxUploadBytes: 9000000, maxJsonDepth: 16 }),
}
