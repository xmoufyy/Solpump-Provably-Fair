import { createHmacV2Source, createSeedrandomV1Source, type IndexSource } from "../crypto/prng.js";
import { buildTranscript, V2_PROTOCOL_LABEL } from "../crypto/transcript.js";
import { utf8Hex } from "../crypto/hmac.js";
import { Trace, type AlgorithmVersion } from "../types.js";

export type KenoDifficulty = "CLASSIC" | "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
export const KENO_DIFFICULTIES: KenoDifficulty[] = ["CLASSIC", "LOW", "MEDIUM", "HIGH", "EXTREME"];

export const BOARD_BY_MODE: Record<KenoDifficulty, { tileCount: number; drawCount: number }> = {
  CLASSIC: { tileCount: 40, drawCount: 10 },
  LOW: { tileCount: 40, drawCount: 10 },
  MEDIUM: { tileCount: 40, drawCount: 10 },
  HIGH: { tileCount: 40, drawCount: 10 },
  EXTREME: { tileCount: 56, drawCount: 10 },
};

export const KENO_MIN_PICKS = 1;
export const KENO_MAX_PICKS = 10;

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
) {
  const trace = new Trace();
  const { tileCount, drawCount } = BOARD_BY_MODE[difficulty];
  trace.add("Configuration", "Difficulty / risk", difficulty, "Risk affects payouts only; EXTREME also changes the board to 56");
  trace.add("Configuration", "Board / draw count", `${tileCount} tiles, ${drawCount} drawn`);
  trace.add("Configuration", "Algorithm version", version);

  let source: IndexSource;
  if (version === "hmac_sha256_v2") {
    const parts = [V2_PROTOCOL_LABEL, "keno", clientSeed, nonce];
    const transcript = buildTranscript(parts);
    trace.add("Transcript", "Parts", JSON.stringify(parts));
    trace.add("Transcript", "Encoded transcript (hex)", transcript.toString("hex"), "Each part: uint32be(byteLength) || UTF-8 bytes");
    trace.add("Transcript", "HMAC key (server seed, UTF-8 hex)", utf8Hex(serverSeed));
    source = createHmacV2Source(serverSeed, transcript);
  } else {
    const seed = `${serverSeed}:${clientSeed}:${nonce}`;
    trace.add("Legacy seed", "seedrandom seed", seed);
    source = createSeedrandomV1Source(seed);
  }

  const numbers = Array.from({ length: tileCount }, (_, i) => i + 1);
  const drawn: number[] = [];
  for (let i = 0; i < drawCount; i++) {
    const index = source.next(numbers.length);
    drawn.push(numbers[index]);
    numbers.splice(index, 1);
  }

  for (const b of source.blocks) trace.add("HMAC blocks", `Block counter ${b.counter}`, b.hex);
  source.draws.forEach((d, i) => {
    const detail =
      d.rawValues !== undefined
        ? d.rawValues
            .map((r) => `${r.value}${r.rejected ? " (rejected >= limit)" : ""} [block ${r.counter} @ byte ${r.offset}]`)
            .join(", ") + ` | limit ${d.limit} | mod ${d.range} = ${d.index}`
        : `rng() = ${d.float} | floor(x * ${d.range}) = ${d.index}`;
    trace.add("Draw", `Draw ${i + 1} (index into ${d.range} remaining)`, `${detail} -> number ${drawn[i]}`);
  });

  return { tileCount, drawCount, drawn, trace };
}
