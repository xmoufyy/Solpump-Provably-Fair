import { createHash, createHmac } from "node:crypto";

/**
 * HMAC-SHA256 where key and every message part are passed to node:crypto as
 * strings (UTF-8) or Buffers exactly as given. Nothing is trimmed or normalised.
 */
export function hmacSha256(key: string | Buffer, ...parts: (string | Buffer)[]): Buffer {
  const mac = createHmac("sha256", key);
  for (const p of parts) mac.update(p);
  return mac.digest();
}

export function hmacSha256Hex(key: string | Buffer, ...parts: (string | Buffer)[]): string {
  return hmacSha256(key, ...parts).toString("hex");
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Visible byte representation of a UTF-8 string, used in traces. */
export function utf8Hex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}
