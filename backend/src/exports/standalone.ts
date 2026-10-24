import type { StoredRound } from "../../../shared/src/contracts.js";
import { ALGORITHM_VERSIONS } from "../../../shared/src/contracts.js";
import { APP_VERSION } from "../verification/engine.js";
import { LIMITATIONS } from "./reports.js";

/**
 * Generates a self-contained Node.js script that re-derives one round's outcome without the Lab.
 * The algorithm code embedded below is a plain transcription of the published reference code;
 * the round data is embedded as a JSON literal (never as code), so seed contents cannot inject code.
 */
const PRELUDE = `import { createHash, createHmac } from "node:crypto";`;

const CRASH = `
function crash(serverSeed, publicSeed) {
  const hash = createHmac("sha256", serverSeed).update(publicSeed).digest("hex");
  if (BigInt("0x" + hash) % 20n === 0n) return 1.0;
  const h = parseInt(hash.slice(0, 13), 16);
  const e = Math.pow(2, 52);
  return Math.floor((100 * e - h) / (e - h)) / 100;
}`;

const BLACKJACK = `
const LABELS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["hearts", "diamonds", "clubs", "spades"];
function card(serverSeed, clientSeed, cardNumber) {
  const hash = createHmac("sha256", serverSeed).update(clientSeed).update(\`\${cardNumber}\`).digest("hex");
  const h = parseInt(hash.slice(0, 13), 16);
  return { label: LABELS[h % 13], suit: SUITS[h % 4] };
}`;

const V2 = `
const encodePart = (value) => {
  const content = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(content.length);
  return Buffer.concat([length, content]);
};
function hmacV2(key, parts) {
  const transcript = Buffer.concat(parts.map(encodePart));
  let counter = 0, block = Buffer.alloc(0), offset = 0;
  const nextUint32 = () => {
    if (offset + 4 > block.length) {
      const c = Buffer.alloc(4);
      c.writeUInt32BE(counter++);
      block = createHmac("sha256", key).update(transcript).update(c).digest();
      offset = 0;
    }
    const v = block.readUInt32BE(offset);
    offset += 4;
    return v;
  };
  return (max) => {
    const limit = 0x1_0000_0000 - (0x1_0000_0000 % max);
    let v;
    do { v = nextUint32(); } while (v >= limit);
    return v % max;
  };
}`;

const V1 = `
async function legacy(seed) {
  let seedrandom;
  try { seedrandom = (await import("seedrandom")).default; }
  catch { console.error("This legacy (seedrandom_v1) round needs the seedrandom package: npm install seedrandom@3.0.5"); process.exit(2); }
  const rng = seedrandom(seed);
  return (max) => Math.floor(rng() * max);
}`;

function safeComment(s: string) {
  return s.replace(/[^\x20-\x7e]/g, "?").replace(/\*\//g, "*?").slice(0, 120);
}

export function standaloneScript(r: StoredRound): string {
  const inputs = r.result.inputs as Record<string, unknown>;
  const v = r.algorithmVersion ?? "";
  const data = {
    recordId: r.id,
    roundId: r.roundId,
    game: r.game,
    algorithmVersion: v,
    inputs,
    recorded: r.recorded,
    labCalculated: r.calculated,
    labStatuses: { outcome: r.outcomeStatus, commitment: r.commitmentStatus, timing: r.timingStatus, overall: r.overallStatus },
    limitations: LIMITATIONS,
  };
  const parts: string[] = [
    "#!/usr/bin/env node",
    `// Solpump Fairness Lab ${APP_VERSION} - standalone reproduction script`,
    `// Record #${r.id}, round ${safeComment(r.roundId ?? "(no id)")}, game ${r.game}, algorithm ${safeComment(v)}`,
    `// Generated ${new Date().toISOString()}. Run with: node <this file>   (Node.js 18 or newer)`,
    "// The algorithm code below is a direct transcription of the published reference code and does not use the Lab.",
    "// Exit code 0 = this script reproduces the Lab's calculation; 1 = it does not.",
    PRELUDE,
    `const ROUND = ${JSON.stringify(data, null, 2)};`,
    "const I = ROUND.inputs;",
  ];
  const same = "const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);\nconst sameSet = (a, b) => a.length === b.length && same([...a].sort((x, y) => x - y), [...b].sort((x, y) => x - y));";
  parts.push(same);

  // Nothing to reproduce: the Lab rejected the inputs, or the record names a version it does not implement.
  // (Never fall back to another version: the version must come from the record.)
  const versioned = r.game === "keno" || r.game === "mines";
  const unsupported = versioned && !(ALGORITHM_VERSIONS as readonly string[]).includes(v);
  if (unsupported || r.outcomeStatus === "invalid_input" || r.outcomeStatus === "unsupported_version") {
    parts.push(
      `console.error(${JSON.stringify(
        unsupported
          ? `Algorithm version ${JSON.stringify(v)} is not implemented, so this round cannot be reproduced. The version is taken from the record and is never substituted.`
          : "The Lab could not reconstruct this record (invalid input), so there is nothing to reproduce.",
      )});\nprocess.exit(1);\n`,
    );
    return parts.join("\n");
  }

  switch (r.game) {
    case "crash":
      parts.push(CRASH, `const calculated = { multiplier: crash(I.serverSeed, I.clientSeed) };
const agreesWithLab = calculated.multiplier === ROUND.labCalculated?.multiplier;
const matchesRecorded = ROUND.recorded?.multiplier == null ? null : ROUND.recorded.multiplier === calculated.multiplier;`);
      break;
    case "blackjack":
      parts.push(BLACKJACK, `const n = ROUND.labCalculated?.cardCount ?? I.cardCount;
const calculated = { cards: Array.from({ length: n }, (_, i) => card(I.serverSeed, I.clientSeed, i + 1)) };
const agreesWithLab = same(calculated.cards, (ROUND.labCalculated?.cards ?? []).map((c) => ({ label: c.label, suit: c.suit })));
const rec = ROUND.recorded?.cards;
const matchesRecorded = rec == null ? null : rec.every((c, i) => c.label === calculated.cards[i].label && c.suit === calculated.cards[i].suit);`);
      break;
    case "keno":
      parts.push(v === "seedrandom_v1" ? V1 : V2, `const BOARD = { CLASSIC: 40, LOW: 40, MEDIUM: 40, HIGH: 40, EXTREME: 56 };
const getIndex = ${v === "seedrandom_v1" ? "await legacy(`${I.serverSeed}:${I.clientSeed}:${I.nonce}`)" : 'hmacV2(I.serverSeed, ["solpump:provably-fair:hmac-sha256:v2", "keno", I.clientSeed, I.nonce])'};
const numbers = Array.from({ length: BOARD[I.difficulty] }, (_, i) => i + 1);
const drawn = [];
for (let i = 0; i < 10; i++) { const k = getIndex(numbers.length); drawn.push(numbers[k]); numbers.splice(k, 1); }
const calculated = { drawn, matches: (I.selectedNumbers ?? []).filter((x) => drawn.includes(x)) };
const agreesWithLab = same(drawn, ROUND.labCalculated?.drawn);
const matchesRecorded = ROUND.recorded?.draw == null ? null : sameSet(ROUND.recorded.draw, drawn);`);
      break;
    case "mines":
      parts.push(v === "seedrandom_v1" ? V1 : V2, `const privateSeed = \`\${I.serverSeed}:\${I.clientSeed}:\${I.nonce}\`;
const getIndex = ${v === "seedrandom_v1" ? "await legacy(privateSeed)" : 'hmacV2(privateSeed, ["solpump:provably-fair:hmac-sha256:v2", "mines", "", "0"])'};
const positions = Array.from({ length: I.gridSize * I.gridSize }, (_, i) => i);
const mines = [];
for (let i = 0; i < I.mineCount; i++) mines.push(positions.splice(getIndex(positions.length), 1)[0]);
const calculated = { mines, note: "0-based, row-major tile indices in generation order" };
const agreesWithLab = same(mines, ROUND.labCalculated?.mines);
// recorded positions were stored 0-based by the Lab
const matchesRecorded = ROUND.recorded?.mines == null ? null : sameSet(ROUND.recorded.mines, mines);`);
      break;
    default:
      parts.push('console.error("This record has no reconstructable game."); process.exit(1);');
  }
  parts.push(`// Candidate only: Solpump's commitment construction is unconfirmed, and equality says nothing about WHEN it was published.
const commitmentCandidate = typeof I.commitment === "string" && I.commitment
  ? { supplied: I.commitment, sha256OfServerSeed: createHash("sha256").update(I.serverSeed, "utf8").digest("hex") }
  : null;
if (commitmentCandidate) commitmentCandidate.equalsSupplied = commitmentCandidate.sha256OfServerSeed === I.commitment.trim().toLowerCase();
console.log(JSON.stringify({
  round: ROUND.roundId, game: ROUND.game, algorithm: ROUND.algorithmVersion, calculated, agreesWithLab, matchesRecorded,
  commitmentCandidate, labStatuses: ROUND.labStatuses,
  meaning: "matchesRecorded = the recorded outcome is consistent with the revealed seeds under this algorithm version. It does not prove the seeds were committed before the round.",
  limitations: ROUND.limitations,
}, null, 2));
process.exit(agreesWithLab ? 0 : 1);
`);
  return parts.join("\n");
}
