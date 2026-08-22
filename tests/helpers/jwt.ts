import { createPublicKey, createSign, generateKeyPairSync } from "node:crypto"
import { vi } from "vitest"

export type TestJwtKeys = {
  privateKeyPem: string
  publicJwk: { kty: "RSA"; n: string; e: string; kid: string; alg: "RS256" }
}

export function generateTestJwtKeys(): TestJwtKeys {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  const jwk = createPublicKey(publicKey).export({ format: "jwk" }) as {
    n: string
    e: string
  }
  return {
    privateKeyPem: privateKey,
    publicJwk: {
      kty: "RSA",
      n: jwk.n,
      e: jwk.e,
      kid: "test-kid",
      alg: "RS256",
    },
  }
}

export function signJwt(
  privateKeyPem: string,
  payload: Record<string, unknown>,
  kid = "test-kid",
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid }),
  ).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const data = `${header}.${body}`
  const sign = createSign("RSA-SHA256")
  sign.update(data)
  sign.end()
  return `${data}.${sign.sign(privateKeyPem, "base64url")}`
}

export function installJwksFetch(keys: TestJwtKeys["publicJwk"][]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/cdn-cgi/access/certs")) {
        return new Response(JSON.stringify({ keys }), { status: 200 })
      }
      return new Response("not found", { status: 404 })
    }),
  )
}
