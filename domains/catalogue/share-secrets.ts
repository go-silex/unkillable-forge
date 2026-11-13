import type { ShareSealKey, ShareVerifierKey } from "./instance-config"

const encoder = new TextEncoder()
const shareKeyPattern = /^[A-Za-z0-9_-]{8,128}$/

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function decodeBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid sealed share")
  }
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4))
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  if (base64url(bytes) !== value) throw new Error("Invalid sealed share")
  return bytes
}

function sealAad(instanceId: string, pageId: string, grantId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`forge.share.seal.v1\0${instanceId}\0${pageId}\0${grantId}`)
}

export function mintShareKey(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(18)))
}

export function isShareKey(value: string): boolean {
  return shareKeyPattern.test(value)
}

export async function shareKeyDigests(
  keys: readonly ShareVerifierKey[],
  instanceId: string,
  key: string,
): Promise<readonly { readonly kid: string; readonly hmac: string }[]> {
  const message = encoder.encode(`forge.share.v1\0${instanceId}\0${key}`)
  return Promise.all(keys.map(async ({ kid, key: verifierKey }) => {
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", verifierKey, message))
    const hmac = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
    return { kid, hmac }
  }))
}

export async function sealShareKey(
  seal: ShareSealKey,
  instanceId: string,
  pageId: string,
  grantId: string,
  key: string,
): Promise<string> {
  if (!isShareKey(key)) throw new Error("Invalid share key")
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: sealAad(instanceId, pageId, grantId) },
    seal.key,
    encoder.encode(key),
  ))
  const sealed = new Uint8Array(iv.length + ciphertext.length)
  sealed.set(iv)
  sealed.set(ciphertext, iv.length)
  return base64url(sealed)
}

export async function unsealShareKey(
  seal: ShareSealKey,
  instanceId: string,
  pageId: string,
  grantId: string,
  sealed: string,
): Promise<string> {
  const bytes = decodeBase64url(sealed)
  if (bytes.length < 28) throw new Error("Invalid sealed share")
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: sealAad(instanceId, pageId, grantId) },
    seal.key,
    bytes.subarray(12),
  )
  const key = new TextDecoder("utf-8", { fatal: true }).decode(plaintext)
  if (!isShareKey(key)) throw new Error("Invalid sealed share")
  return key
}
