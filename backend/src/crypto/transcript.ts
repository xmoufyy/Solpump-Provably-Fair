/** Solpump "hmac-sha256:v2" transcript framing (published reference code). */
export const V2_PROTOCOL_LABEL = "solpump:provably-fair:hmac-sha256:v2";

/** 4-byte big-endian length prefix followed by the UTF-8 bytes of the value. */
export function encodePart(value: string): Buffer {
  const content = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(content.length);
  return Buffer.concat([length, content]);
}

export function buildTranscript(parts: string[]): Buffer {
  return Buffer.concat(parts.map(encodePart));
}
