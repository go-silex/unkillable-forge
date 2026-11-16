import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/filesystem.ts
import { randomBytes } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { basename, dirname as dirname2, isAbsolute, join as join2 } from "node:path";

// src/posix.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
function record(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
var hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
var nonempty = (value) => typeof value === "string" && value.length > 0;
function load() {
  if (!["linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch) || Number(process.versions.napi) < 8) throw new Error("native_unsupported");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const nativeDir = join(moduleDir, moduleDir.endsWith("/src") ? "../dist/native" : "native");
  try {
    const manifest = JSON.parse(readFileSync(join(nativeDir, "manifest.json"), "utf8"));
    if (!record(manifest, ["format", "version", "napiVersion", "artifacts"]) || manifest.format !== "unkillable-forge-native" || manifest.version !== 1 || manifest.napiVersion !== 8 || !Array.isArray(manifest.artifacts)) throw new Error();
    const selected = manifest.artifacts.filter((a2) => record(a2, ["platform", "arch", "file", "sha256", "sourceInputSha256", "nodeHeaders", "toolchain", "provenance"]) && a2.platform === process.platform && a2.arch === process.arch);
    if (selected.length !== 1) throw new Error();
    const a = selected[0];
    const headers = a.nodeHeaders, toolchain = a.toolchain, provenance = a.provenance;
    if (a.file !== `${process.platform}-${process.arch}/posix.node` || !hex(a.sha256) || !hex(a.sourceInputSha256) || !record(headers, ["version", "sha256"]) || !nonempty(headers.version) || !hex(headers.sha256) || !record(toolchain, ["compiler", "target", "osFloor", "libcFloor", "sdk"]) || !nonempty(toolchain.compiler) || !nonempty(toolchain.target) || !nonempty(toolchain.osFloor) || !(toolchain.libcFloor === null || nonempty(toolchain.libcFloor)) || !(toolchain.sdk === null || nonempty(toolchain.sdk))) throw new Error();
    if (!(record(provenance, ["kind"]) && provenance.kind === "local") && !(record(provenance, ["kind", "repository", "runId", "inputSha"]) && provenance.kind === "ci" && provenance.repository === "go-silex/unkillable-forge" && nonempty(provenance.runId) && nonempty(provenance.inputSha))) throw new Error();
    const path = join(nativeDir, a.file);
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== a.sha256) throw new Error();
    return createRequire(import.meta.url)(path);
  } catch {
    throw new Error("native_payload_invalid");
  }
}
var bridge;
function native() {
  return bridge ??= load();
}

// src/filesystem.ts
function component(name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || name.includes("/") || name.includes("\0") || !name.isWellFormed()) throw new Error("invalid_path");
}
async function resolvedRoot(path, createLeaf) {
  if (!isAbsolute(path) || !path.isWellFormed() || path.includes("\0")) throw new Error("invalid_root");
  try {
    return await realpath(path);
  } catch (error) {
    if (!createLeaf || error.code !== "ENOENT") throw error;
    const leaf = basename(path);
    component(leaf);
    return join2(await realpath(dirname2(path)), leaf);
  }
}
async function bind(path, privateRoot, createLeaf) {
  const resolved = await resolvedRoot(path, createLeaf);
  const parts = resolved.split("/").filter(Boolean);
  let current = native().root();
  try {
    for (let i = 0; i < parts.length; i++) {
      component(parts[i]);
      const last = i === parts.length - 1;
      const next = native().child(current, parts[i], privateRoot && createLeaf && last, privateRoot && last);
      native().close(current);
      current = next;
    }
    if (privateRoot && parts.length === 0) throw new Error("invalid_root");
    return current;
  } catch (error) {
    native().close(current);
    throw error;
  }
}
var HeldDirectory = class {
  constructor(handle) {
    this.handle = handle;
  }
  handle;
  active = 0;
  closing = false;
  done;
  finish;
  async use(action) {
    if (this.closing) throw new Error("filesystem_closed");
    this.active++;
    try {
      return await action(this.handle);
    } finally {
      if (--this.active === 0 && this.closing) this.finish?.();
    }
  }
  async close() {
    if (!this.done) {
      this.closing = true;
      this.done = (async () => {
        if (this.active) {
          const gate = Promise.withResolvers();
          this.finish = gate.resolve;
          await gate.promise;
        }
        native().close(this.handle);
      })();
    }
    return this.done;
  }
};
async function adopt(carrier, writable) {
  let file;
  try {
    const bridge2 = native();
    const identity = bridge2.identity(carrier);
    const alias = process.platform === "linux" ? "/proc/self/fd/" : "/dev/fd/";
    file = await open(alias + bridge2.fd(carrier), writable ? "r+" : "r");
    const stat = await file.stat({ bigint: true });
    if (stat.dev !== identity.dev || stat.ino !== identity.ino || Number(stat.mode & 0o170000n) !== identity.type || !stat.isFile()) throw new Error("filesystem_identity_mismatch");
    return file;
  } catch (error) {
    if (file) await file.close();
    throw error;
  } finally {
    native().close(carrier);
  }
}
var Source = class extends HeldDirectory {
  async open(path) {
    if (typeof path !== "string" || path.startsWith("/")) throw new Error("invalid_source");
    const parts = path.split("/");
    parts.forEach(component);
    return this.use(async (root) => {
      let parent;
      try {
        for (const part of parts.slice(0, -1)) {
          const next = native().child(parent ?? root, part, false, false);
          if (parent) native().close(parent);
          parent = next;
        }
        return await adopt(native().file(parent ?? root, parts[parts.length - 1], 0), false);
      } finally {
        if (parent) native().close(parent);
      }
    });
  }
};
var Private = class _Private extends HeldDirectory {
  async child(name, create) {
    component(name);
    return this.use((h) => new _Private(native().child(h, name, create, true)));
  }
  async open(name, mode) {
    component(name);
    if (mode !== "read" && mode !== "exclusive") throw new Error("invalid_mode");
    return this.use((h) => adopt(native().file(h, name, mode === "read" ? 1 : 2), mode === "exclusive"));
  }
  async replace(name, bytes) {
    component(name);
    return this.use(async (h) => {
      const temp = `.tmp-${randomBytes(24).toString("hex")}`;
      let created = false;
      try {
        const carrier = native().file(h, temp, 2);
        created = true;
        const file = await adopt(carrier, true);
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        native().mutation(h, temp, 0, name);
        created = false;
        native().sync(h);
      } finally {
        if (created) native().mutation(h, temp, 1, "");
      }
    });
  }
  async unlink(name) {
    component(name);
    await this.use((h) => native().mutation(h, name, 1, ""));
  }
  async names() {
    return this.use((h) => native().names(h));
  }
  async removeEmptyChild(name) {
    component(name);
    await this.use((h) => native().mutation(h, name, 2, ""));
  }
  async availableBytes() {
    return this.use((h) => native().space(h));
  }
  async locked(name, wait, action) {
    component(name);
    return this.use(async (h) => {
      const lock = native().file(h, name, 3);
      let acquired = false;
      try {
        for (; ; ) {
          if (wait.signal?.aborted) throw new Error("lock_aborted");
          if (Date.now() >= wait.deadlineMs) throw new Error("lock_timeout");
          if (native().lock(lock, true)) {
            acquired = true;
            break;
          }
          const { promise, resolve, reject } = Promise.withResolvers();
          const signal = wait.signal;
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          }, Math.min(50, Math.max(0, wait.deadlineMs - Date.now())));
          const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(new Error("lock_aborted"));
          };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          await promise;
        }
        return await action();
      } finally {
        try {
          if (acquired) native().lock(lock, false);
        } finally {
          native().close(lock);
        }
      }
    });
  }
};
async function bindSourceRoot(approvedAbsoluteRoot) {
  return new Source(await bind(approvedAbsoluteRoot, false, false));
}
async function bindPrivateRoot(approvedAbsoluteRoot, createLeaf) {
  return new Private(await bind(approvedAbsoluteRoot, true, createLeaf));
}
async function withPrivateLock(root, name, wait, action) {
  if (!(root instanceof Private) || !Number.isFinite(wait.deadlineMs)) throw new Error("invalid_lock");
  return root.locked(name, wait, action);
}

export {
  __commonJS,
  __export,
  __toESM,
  bindSourceRoot,
  bindPrivateRoot,
  withPrivateLock
};
