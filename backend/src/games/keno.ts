import { createHmacV2Source, createSeedrandomV1Source, describeDraw, type IndexSource } from "../crypto/prng.js";
import { buildTranscript, V2_PROTOCOL_LABEL } from "../crypto/transcript.js";
import { utf8Hex } from "../crypto/hmac.js";
import { Trace, type AlgorithmVersion, type ComputeOptions } from "../types.js";
import { KENO_BOARD, type KenoDifficulty } from "../../../shared/src/contracts.js";

export { KENO_DIFFICULTIES, KENO_MAX_PICKS, KENO_MIN_PICKS, type KenoDifficulty } from "../../../shared/src/contracts.js";
export const BOARD_BY_MODE = KENO_BOARD;

/**
 * Published Solpump Keno draw.
 *  v2: HMAC key = serverSeed; transcript = enc(label) || enc("keno") || enc(clientSeed) || enc(nonce)
 *  v1: seedrandom(`${serverSeed}:${clientSeed}:${nonce}`)
 * Player picks and risk level are NOT inputs to the draw; only EXTREME changes the population (56).
 */
export function computeKeno(
  serverSeed: string,
  clientSeed: string,
  nonce: string,
  version: AlgorithmVersion,
  difficulty: KenoDifficulty,
  opts: ComputeOptions = {},
) {
  const tracing = opts.trace ?? true;
  const trace = new Trace(tracing);
  const { tileCount, drawCount } = KENO_BOARD[difficulty];
  trace.add("Configuration", "Difficulty / risk", difficulty, "Risk affects payouts only; EXTREME also changes the board to 56");
  trace.add("Configuration", "Board / draw count", `${tileCount} tiles, ${drawCount} drawn`);
  trace.add("Configuration", "Algorithm version", version);

  let source: IndexSource;
  if (version === "hmac_sha256_v2") {
    const parts = [V2_PROTOCOL_LABEL, "keno", clientSeed, nonce];
    const transcript = buildTranscript(parts);
    if (tracing) {
      trace.add("Key", "HMAC key = server seed (UTF-8 bytes, hex)", utf8Hex(serverSeed));
      trace.add("Transcript", "Parts", JSON.stringify(parts));
      trace.add("Transcript", "Encoded transcript (hex)", transcript.toString("hex"), "Each part: uint32be(UTF-8 byte length) || UTF-8 bytes");
      trace.add("Transcript", "Block n", "HMAC-SHA256(key, transcript || uint32be(n)), read as 8 big-endian uint32 values");
    }
    source = createHmacV2Source(serverSeed, transcript, tracing);
  } else {
    const seed = `${serverSeed}:${clientSeed}:${nonce}`;
    trace.add("Legacy seed", "seedrandom seed", seed);
    source = createSeedrandomV1Source(seed, tracing);
  }

  const numbers = Array.from({ length: tileCount }, (_, i) => i + 1);
  const drawn: number[] = [];
  for (let i = 0; i < drawCount; i++) {
    const index = source.next(numbers.length);
    drawn.push(numbers[index]);
    numbers.splice(index, 1);
  }

  if (tracing) {
    for (const b of source.blocks) trace.add("HMAC blocks", `Block counter ${b.counter}`, b.hex);
    source.draws.forEach((d, i) => trace.add("Draw", `Draw ${i + 1} (index into ${d.range} remaining)`, `${describeDraw(d)} -> number ${drawn[i]}`));
  }

  return { tileCount, drawCount, drawn, indices: source.indices, blockCount: source.blockCount(), trace };
}
