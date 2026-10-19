import seedrandom from "seedrandom";
import { hmacSha256 } from "./hmac.js";

export const UINT32_RANGE = 0x1_0000_0000;

export interface IndexDraw {
  range: number;
  index: number;
  /** v2: every uint32 consumed, including rejected samples */
  rawValues?: { value: number; counter: number; offset: number; rejected: boolean }[];
  limit?: number;
  /** legacy: raw double returned by rng() */
  float?: number;
}

export interface IndexSource {
  next(maxExclusive: number): number;
  /** every returned index, in order (always recorded; cheap) */
  readonly indices: number[];
  /** detailed per-draw records (only when tracing) */
  readonly draws: IndexDraw[];
  /** v2: every HMAC block generated (only when tracing) */
  readonly blocks: { counter: number; hex: string }[];
  /** v2: number of HMAC blocks generated (always) */
  blockCount(): number;
}

function assertRange(maxExclusive: number) {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > UINT32_RANGE) {
    throw new RangeError(`invalid index range ${maxExclusive}`);
  }
}

/** Largest multiple of maxExclusive that fits in 2^32; samples at or above it are rejected. */
export function rejectionLimit(maxExclusive: number): number {
  assertRange(maxExclusive);
  return UINT32_RANGE - (UINT32_RANGE % maxExclusive);
}

/**
 * Pure rejection sampling exactly as published:
 *   limit = 2^32 - (2^32 % max); do { v = nextUint32() } while (v >= limit); return v % max
 * Exported separately so the (astronomically rare) rejection path can be tested with crafted values.
 */
export function uniformIndex(nextUint32: () => number, maxExclusive: number, onSample?: (value: number, rejected: boolean) => void): number {
  const limit = rejectionLimit(maxExclusive);
  let value: number;
  do {
    value = nextUint32();
    onSample?.(value, value >= limit);
  } while (value >= limit);
  return value % maxExclusive;
}

/**
 * Exact port of the published HMAC v2 generator:
 *   block_n = HMAC-SHA256(key, transcript || uint32be(n)), n = 0,1,2,...
 * Each 32-byte block is consumed as eight big-endian uint32 values.
 */
export function createHmacV2Source(key: string, transcript: Buffer, trace = true): IndexSource {
  let counter = 0;
  let block: Buffer = Buffer.alloc(0);
  let blockOffset = 0;
  let blockCounter = -1;
  const counterBuffer = Buffer.alloc(4);
  const indices: number[] = [];
  const draws: IndexDraw[] = [];
  const blocks: { counter: number; hex: string }[] = [];
  let lastOffset = 0;

  const nextUint32 = () => {
    if (blockOffset + 4 > block.length) {
      blockCounter = counter;
      counterBuffer.writeUInt32BE(counter++);
      block = hmacSha256(key, transcript, counterBuffer);
      if (trace) blocks.push({ counter: blockCounter, hex: block.toString("hex") });
      blockOffset = 0;
    }
    lastOffset = blockOffset;
    const value = block.readUInt32BE(blockOffset);
    blockOffset += 4;
    return value;
  };

  const next = (maxExclusive: number) => {
    if (!trace) {
      const index = uniformIndex(nextUint32, maxExclusive);
      indices.push(index);
      return index;
    }
    const rawValues: NonNullable<IndexDraw["rawValues"]> = [];
    const index = uniformIndex(nextUint32, maxExclusive, (value, rejected) =>
      rawValues.push({ value, counter: blockCounter, offset: lastOffset, rejected }),
    );
    indices.push(index);
    draws.push({ range: maxExclusive, index, rawValues, limit: rejectionLimit(maxExclusive) });
    return index;
  };

  return { next, indices, draws, blocks, blockCount: () => counter };
}

/** Exact port of the published legacy generator: Math.floor(seedrandom(seed)() * max). */
export function createSeedrandomV1Source(seed: string, trace = true): IndexSource {
  const rng = seedrandom(seed);
  const indices: number[] = [];
  const draws: IndexDraw[] = [];
  const next = (maxExclusive: number) => {
    assertRange(maxExclusive);
    const float = rng();
    const index = Math.floor(float * maxExclusive);
    indices.push(index);
    if (trace) draws.push({ range: maxExclusive, index, float });
    return index;
  };
  return { next, indices, draws, blocks: [], blockCount: () => 0 };
}

/** Shared trace formatting for the Keno and Mines draws. */
export function describeDraw(d: IndexDraw): string {
  if (d.rawValues !== undefined) {
    return (
      d.rawValues
        .map((r) => `${r.value}${r.rejected ? " (rejected >= limit)" : ""} [block ${r.counter} @ byte ${r.offset}]`)
        .join(", ") + ` | limit ${d.limit} | ${d.rawValues[d.rawValues.length - 1].value} mod ${d.range} = ${d.index}`
    );
  }
  return `rng() = ${d.float} | floor(${d.float} * ${d.range}) = ${d.index}`;
}
