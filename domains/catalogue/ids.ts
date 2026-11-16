export type IdPrefix = "pg" | "ar" | "rv" | "gr" | "pr" | "rg" | "ev" | "ps" | "pe"

/** Encode 128 random bits as unpadded lowercase RFC 4648 base32. */
export function newId(prefix: IdPrefix): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
  let bits = 0
  let value = 0
  let encoded = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      encoded += alphabet[(value >>> bits) & 31]
    }
  }
  if (bits) encoded += alphabet[(value << (5 - bits)) & 31]
  return `${prefix}_${encoded}`
}
