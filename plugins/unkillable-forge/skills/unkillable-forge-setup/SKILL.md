---
name: unkillable-forge-setup
description: Configure an explicit Unkillable Forge instance profile and native client, or reconnect its local publisher.
---

# Set up Unkillable Forge

1. Obtain the operator's explicit instance profile, approved OAuth issuer and endpoint origin, read and management origins, and selected absolute local roots. Keep the profile and private state outside the release directory. Do not infer an instance or reuse legacy credentials.
2. Use `dist/forge.js` from the reviewed complete installed `dist/` directory and an absolute Node path. Run `profile-check` with `--profile`, `--client` and `--state-dir` as documented in the package README. Resolve any refusal before continuing.
3. Have the operator explicitly run `connect` with the same profile, client and state directory, and complete the native interactive authorization. Never request or copy tokens into chat.
4. Run `config-proposal` with the same arguments plus the explicit `--name`, `--node`, `--bundle` and `--home` paths. Present the proposed per-instance entry for operator review; it does not apply the configuration. Preserve other client settings and native provider login.
5. After the operator installs the entry, confirm that the native client discovers the local Forge tools. Report discovery separately from any authorization or publication proof.
