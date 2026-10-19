import { createHmacV2Source, createSeedrandomV1Source, type IndexSource } from "../crypto/prng.js";
import { buildTranscript, V2_PROTOCOL_LABEL } from "../crypto/transcript.js";
import { utf8Hex } from "../crypto/hmac.js";
import { Trace, type AlgorithmVersion } from "../types.js";

/** Solpump Mines board sizes: 3x3, 5x5, 6x6, 7x7, 8x8. */
export const MINES_GRID_SIZES = [3, 5, 6, 7, 8] as const;
export type MinesGridSize = (typeof MINES_GRID_SIZES)[number];
export const MINES_TILE_COUNTS = MINES_GRID_SIZES.map((g) => g * g);

export function gridSizeFromTileCount(tileCount: number): MinesGridSize | null {
  return MINES_GRID_SIZES.find((s) => s * s === tileCount) ?? null;
}

/**
 * Published Solpump Mines placement.
 *  privateSeed = `${serverSeed}:${clientSeed}:${nonce}`
 *  v2: HMAC key = privateSeed; transcript = enc(label) || enc("mines") || enc("") || enc("0")   (literal "" and "0")
 *  v1: seedrandom(privateSeed)
 * Positions are zero-based; generation order is preserved.
 */
export function computeMines(
  serverSeed: string,
  clientSeed: string,
  nonce: string,
  version: AlgorithmVersion,
  gridSize: MinesGridSize,
  mineCount: number,
) {
  const trace = new Trace();
  const tileCount = gridSize * gridSize;
  if (!Number.isInteger(mineCount) || mineCount < 1 || mineCount > tileCount - 1) {
    throw new Error(`mineCount must be 1-${tileCount - 1} for a ${gridSize}x${gridSize} grid`);
  }
  const privateSeed = `${serverSeed}:${clientSeed}:${nonce}`;
  trace.add("Configuration", "Grid", `${gridSize}x${gridSize} (${tileCount} tiles, indices 0-${tileCount - 1})`);
  trace.add("Configuration", "Mine count", String(mineCount));
  trace.add("Configuration", "Algorithm version", version);
  trace.add("Private seed", "serverSeed:clientSeed:nonce", privateSeed);

  let source: IndexSource;
  if (version === "hmac_sha256_v2") {
    const parts = [V2_PROTOCOL_LABEL, "mines", "", "0"];
    const transcript = buildTranscript(parts);
    trace.add("Transcript", "Parts (literal empty string and \"0\")", JSON.stringify(parts));
    trace.add("Transcript", "Encoded transcript (hex)", transcript.toString("hex"));
    trace.add("Transcript", "HMAC key (private seed, UTF-8 hex)", utf8Hex(privateSeed), "Mines keys the HMAC with the private seed, not the server seed");
    source = createHmacV2Source(privateSeed, transcript);
  } else {
    trace.add("Legacy seed", "seedrandom seed", privateSeed);
    source = createSeedrandomV1Source(privateSeed);
  }

  const positions = Array.from({ length: tileCount }, (_, i) => i);
  const mines: number[] = [];
  for (let i = 0; i < mineCount; i++) {
    const index = source.next(positions.length);
    mines.push(positions.splice(index, 1)[0]);
  }

  for (const b of source.blocks) trace.add("HMAC blocks", `Block counter ${b.counter}`, b.hex);
  source.draws.forEach((d, i) => {
    const detail =
      d.rawValues !== undefined
        ? d.rawValues.map((r) => `${r.value}${r.rejected ? " (rejected)" : ""}`).join(", ") + ` | mod ${d.range} = ${d.index}`
        : `rng() = ${d.float} | floor(x * ${d.range}) = ${d.index}`;
    const t = mines[i];
    trace.add("Placement", `Mine ${i + 1}`, `${detail} -> tile ${t} (row ${Math.floor(t / gridSize) + 1}, col ${(t % gridSize) + 1})`);
  });

  const safe = positions.slice().sort((a, b) => a - b);
  return { tileCount, gridSize, mines, minesSorted: [...mines].sort((a, b) => a - b), safe, trace };
}
