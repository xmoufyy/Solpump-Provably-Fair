import { hmacSha256Hex, utf8Hex } from "../crypto/hmac.js";
import { Trace, type ComputeOptions } from "../types.js";

const E = Math.pow(2, 52);

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
 * There is no nonce. The result is always k/100 for an integer k >= 100.
 */
export function computeCrash(serverSeed: string, publicSeed: string, opts: ComputeOptions = {}): CrashResult {
  const trace = new Trace(opts.trace ?? true);
  trace.add("Inputs", "HMAC key = server seed (UTF-8 bytes, hex)", utf8Hex(serverSeed));
  trace.add("Inputs", "HMAC message = public seed (UTF-8 bytes, hex)", utf8Hex(publicSeed));

  const digest = hmacSha256Hex(serverSeed, publicSeed);
  trace.add("HMAC", "HMAC-SHA256(serverSeed, publicSeed)", digest);

  const mod20 = Number(BigInt("0x" + digest) % 20n);
  trace.add("Instant crash", "BigInt(digest) mod 20", String(mod20), "The full 256-bit digest is used; remainder 0 (probability 1/20) means an instant 1.00x crash");

  if (mod20 === 0) {
    trace.add("Instant crash", "Result", "remainder is 0 -> instant crash at 1.00x");
    return { digest, mod20, instantCrash: true, h: null, e: E, multiplier: 1.0, trace };
  }

  const h = parseInt(digest.slice(0, 13), 16);
  const numerator = 100 * E - h;
  const denominator = E - h;
  const ratio = numerator / denominator;
  const multiplier = Math.floor(ratio) / 100;
  trace.add("Formula", "First 13 hex chars (52 bits)", digest.slice(0, 13));
  trace.add("Formula", "h = parseInt(first13, 16)", String(h));
  trace.add("Formula", "e = 2^52", String(E));
  trace.add("Formula", "100*e - h  (double)", String(numerator));
  trace.add("Formula", "e - h", String(denominator));
  trace.add("Formula", "(100*e - h) / (e - h)", String(ratio));
  trace.add("Formula", "floor(ratio) / 100", multiplier.toFixed(2));
  return { digest, mod20, instantCrash: false, h, e: E, multiplier, trace };
}
