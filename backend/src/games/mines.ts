import { createHmacV2Source, createSeedrandomV1Source, describeDraw, type IndexSource } from "../crypto/prng.js";
import { buildTranscript, V2_PROTOCOL_LABEL } from "../crypto/transcript.js";
import { utf8Hex } from "../crypto/hmac.js";
import { Trace, type AlgorithmVersion, type ComputeOptions } from "../types.js";
import { MINES_GRID_SIZES, type MinesGridSize } from "../../../shared/src/contracts.js";

export { MINES_GRID_SIZES, type MinesGridSize } from "../../../shared/src/contracts.js";
export const MINES_TILE_COUNTS = MINES_GRID_SIZES.map((g) => g * g);

export function gridSizeFromTileCount(tileCount: number): MinesGridSize | null {
  return MINES_GRID_SIZES.find((s) => s * s === tileCount) ?? null;
}

/**
 * Published Solpump Mines placement.
 *  privateSeed = `${serverSeed}:${clientSeed}:${nonce}`
 *  v2: HMAC key = privateSeed; transcript = enc(label) || enc("mines") || enc("") || enc("0")   (literal "" and "0")
 *  v1: seedrandom(privateSeed)
 * Positions are zero-based, row-major; generation order is preserved.
 */
export function computeMines(
  serverSeed: string,
  clientSeed: string,
  nonce: string,
  version: AlgorithmVersion,
  gridSize: MinesGridSize,
  mineCount: number,
  opts: ComputeOptions = {},
) {
  const tracing = opts.trace ?? true;
  const trace = new Trace(tracing);
  const tileCount = gridSize * gridSize;
  if (!Number.isInteger(mineCount) || mineCount < 1 || mineCount > tileCount - 1) {
    throw new RangeError(`mineCount must be 1-${tileCount - 1} for a ${gridSize}x${gridSize} grid`);
  }
  const privateSeed = `${serverSeed}:${clientSeed}:${nonce}`;
  trace.add("Configuration", "Grid", `${gridSize}x${gridSize} (${tileCount} tiles, indices 0-${tileCount - 1}, row-major)`);
  trace.add("Configuration", "Mine count", String(mineCount));
  trace.add("Configuration", "Algorithm version", version);
  trace.add("Private seed", "serverSeed + \":\" + clientSeed + \":\" + nonce", privateSeed);

  let source: IndexSource;
  if (version === "hmac_sha256_v2") {
    const parts = [V2_PROTOCOL_LABEL, "mines", "", "0"];
    const transcript = buildTranscript(parts);
    if (tracing) {
      trace.add("Key", "HMAC key = private seed (UTF-8 bytes, hex)", utf8Hex(privateSeed), "Mines keys the HMAC with the private seed, not the server seed");
      trace.add("Transcript", "Parts (literal empty string and \"0\")", JSON.stringify(parts));
      trace.add("Transcript", "Encoded transcript (hex)", transcript.toString("hex"));
    }
    source = createHmacV2Source(privateSeed, transcript, tracing);
  } else {
    trace.add("Legacy seed", "seedrandom seed", privateSeed);
    source = createSeedrandomV1Source(privateSeed, tracing);
  }

  const positions = Array.from({ length: tileCount }, (_, i) => i);
  const mines: number[] = [];
  for (let i = 0; i < mineCount; i++) {
    const index = source.next(positions.length);
    mines.push(positions.splice(index, 1)[0]);
  }

  if (tracing) {
    for (const b of source.blocks) trace.add("HMAC blocks", `Block counter ${b.counter}`, b.hex);
    source.draws.forEach((d, i) => {
      const t = mines[i];
      trace.add("Placement", `Mine ${i + 1} (index into ${d.range} remaining)`, `${describeDraw(d)} -> tile #${t} (row ${Math.floor(t / gridSize) + 1}, col ${(t % gridSize) + 1})`);
    });
  }

  const safe = positions.slice().sort((a, b) => a - b);
  return { tileCount, gridSize, mines, minesSorted: [...mines].sort((a, b) => a - b), safe, indices: source.indices, blockCount: source.blockCount(), trace };
}
