import seedrandom from "seedrandom";
import { hmacSha256 } from "./hmac.js";

export interface IndexDraw {
  /** maxExclusive passed to getIndex */
  range: number;
  /** final index returned */
  index: number;
  /** raw uint32 values consumed (v2) – includes rejected samples */
  rawValues?: { value: number; counter: number; offset: number; rejected: boolean }[];
  /** rejection-sampling limit (v2) */
  limit?: number;
  /** raw float from rng() (legacy) */
  float?: number;
}

export interface IndexSource {
  next(maxExclusive: number): number;
  draws: IndexDraw[];
  /** v2 only: every HMAC block that was generated */
  blocks: { counter: number; hex: string }[];
}

/**
 * Exact port of the published HMAC v2 generator:
 *   block_n = HMAC-SHA256(key, transcript || uint32be(n)), n = 0,1,2,…
 * Each block is read as 8 big-endian uint32s; rejection sampling avoids modulo bias.
 */
export function createHmacV2Source(key: string, transcript: Buffer): IndexSource {
  let counter = 0;
  let block: Buffer = Buffer.alloc(0);
  let blockOffset = 0;
  let blockCounter = -1;
  const blocks: { counter: number; hex: string }[] = [];
  const draws: IndexDraw[] = [];

  const nextUint32 = () => {
    if (blockOffset + 4 > block.length) {
      const counterBuffer = Buffer.alloc(4);
      blockCounter = counter;
      counterBuffer.writeUInt32BE(counter++);
      block = hmacSha256(key, transcript, counterBuffer);
      blocks.push({ counter: blockCounter, hex: block.toString("hex") });
      blockOffset = 0;
    }
    const offset = blockOffset;
    const value = block.readUInt32BE(blockOffset);
    blockOffset += 4;
    return { value, counter: blockCounter, offset };
  };

  const next = (maxExclusive: number) => {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1) throw new Error(`invalid range ${maxExclusive}`);
    const limit = 0x1_0000_0000 - (0x1_0000_0000 % maxExclusive);
    const rawValues: NonNullable<IndexDraw["rawValues"]> = [];
    let sample;
    do {
      sample = nextUint32();
      rawValues.push({ ...sample, rejected: sample.value >= limit });
    } while (sample.value >= limit);
    const index = sample.value % maxExclusive;
    draws.push({ range: maxExclusive, index, rawValues, limit });
    return index;
  };

  return { next, draws, blocks };
}

/** Exact port of the published legacy generator: Math.floor(seedrandom(seed)() * max). */
export function createSeedrandomV1Source(seed: string): IndexSource {
  const rng = seedrandom(seed);
  const draws: IndexDraw[] = [];
  const next = (maxExclusive: number) => {
    const float = rng();
    const index = Math.floor(float * maxExclusive);
    draws.push({ range: maxExclusive, index, float });
    return index;
  };
  return { next, draws, blocks: [] };
}
