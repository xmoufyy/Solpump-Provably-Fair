import { hmacSha256Hex, utf8Hex } from "../crypto/hmac.js";
import { Trace } from "../types.js";

export interface CrashResult {
  digest: string;
  mod20: number;
  instantCrash: boolean;
  h: number | null;
  e: number;
  multiplier: number;
  trace: Trace;
}

/**
 * Published Solpump Crash algorithm.
 *   digest = HMAC-SHA256(key = serverSeed, message = publicSeed)
 *   if BigInt(digest) % 20 == 0 -> 1.00
 *   h = parseInt(digest[0..13], 16); e = 2^52
 *   multiplier = floor((100e - h) / (e - h)) / 100        (IEEE-754 double arithmetic, as in JS)
 * There is no nonce.
 */
export function computeCrash(serverSeed: string, publicSeed: string): CrashResult {
  const trace = new Trace();
  trace.add("Inputs", "HMAC key (server seed, UTF-8 hex)", utf8Hex(serverSeed));
  trace.add("Inputs", "HMAC message (public seed, UTF-8 hex)", utf8Hex(publicSeed));

  const digest = hmacSha256Hex(serverSeed, publicSeed);
  trace.add("HMAC", "HMAC-SHA256(serverSeed, publicSeed)", digest);

  const mod20 = Number(BigInt("0x" + digest) % 20n);
  trace.add("Instant crash", "BigInt(digest) mod 20", String(mod20), "The full 256-bit digest is used for this test");
  const e = Math.pow(2, 52);

  if (mod20 === 0) {
    trace.add("Instant crash", "Result", "remainder is 0 -> instant crash at 1.00x");
    return { digest, mod20, instantCrash: true, h: null, e, multiplier: 1.0, trace };
  }

  const h = parseInt(digest.slice(0, 13), 16);
  trace.add("Formula", "First 13 hex chars", digest.slice(0, 13));
  trace.add("Formula", "h = parseInt(first13, 16)  (52-bit)", String(h));
  trace.add("Formula", "e = 2^52", String(e));
  const numerator = 100 * e - h;
  const denominator = e - h;
  const ratio = numerator / denominator;
  trace.add("Formula", "100*e - h", String(numerator));
  trace.add("Formula", "e - h", String(denominator));
  trace.add("Formula", "(100*e - h) / (e - h)", String(ratio));
  const multiplier = Math.floor(ratio) / 100;
  trace.add("Formula", "floor(ratio) / 100", multiplier.toFixed(2));
  return { digest, mod20, instantCrash: false, h, e, multiplier, trace };
}
