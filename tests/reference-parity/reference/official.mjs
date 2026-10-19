// INDEPENDENT REFERENCE IMPLEMENTATION
// Plain JavaScript transcribed directly from the published Solpump reference code
// (as supplied in the project specification). It deliberately shares NO code with
// backend/src so that parity tests compare two separate implementations.
import { createHmac } from "node:crypto";
import seedrandom from "seedrandom";

// ---------------- Crash ----------------
export function verifyCrash(serverSeed, clientSeed) {
  const saltedSeed = createHmac("sha256", serverSeed).update(clientSeed).digest("hex");
  if (BigInt("0x" + saltedSeed) % 20n === 0n) {
    return 1.0;
  }
  const h = parseInt(saltedSeed.slice(0, 13), 16);
  const e = Math.pow(2, 52);
  return Math.floor((100 * e - h) / (e - h)) / 100;
}

// ---------------- Blackjack ----------------
const AVAILABLE_LABELS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const AVAILABLE_SUITS = ["hearts", "diamonds", "clubs", "spades"];

export function generateCard(serverSeed, clientSeed, cardNumber) {
  const saltedSeed = createHmac("sha256", serverSeed).update(clientSeed).update(`${cardNumber}`).digest("hex");
  const h = parseInt(saltedSeed.slice(0, 13), 16);
  return { label: AVAILABLE_LABELS[h % 13], suit: AVAILABLE_SUITS[h % 4] };
}

// ---------------- shared v2 ----------------
const encodePart = (value) => {
  const content = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(content.length);
  return Buffer.concat([length, content]);
};

function makeV2(key, transcript) {
  let counter = 0;
  let block = Buffer.alloc(0);
  let blockOffset = 0;
  const nextUint32 = () => {
    if (blockOffset + 4 > block.length) {
      const counterBuffer = Buffer.alloc(4);
      counterBuffer.writeUInt32BE(counter++);
      block = createHmac("sha256", key).update(transcript).update(counterBuffer).digest();
      blockOffset = 0;
    }
    const value = block.readUInt32BE(blockOffset);
    blockOffset += 4;
    return value;
  };
  const nextIndex = (maxExclusive) => {
    const limit = 0x1_0000_0000 - (0x1_0000_0000 % maxExclusive);
    let value;
    do {
      value = nextUint32();
    } while (value >= limit);
    return value % maxExclusive;
  };
  return nextIndex;
}

// ---------------- Keno ----------------
const boardByMode = {
  CLASSIC: { tileCount: 40, drawCount: 10 },
  LOW: { tileCount: 40, drawCount: 10 },
  MEDIUM: { tileCount: 40, drawCount: 10 },
  HIGH: { tileCount: 40, drawCount: 10 },
  EXTREME: { tileCount: 56, drawCount: 10 },
};

export function kenoDraw(serverSeed, clientSeed, nonce, version, mode) {
  const { tileCount } = boardByMode[mode];
  let getIndex;
  if (version === "hmac_sha256_v2") {
    const transcript = Buffer.concat([
      encodePart("solpump:provably-fair:hmac-sha256:v2"),
      encodePart("keno"),
      encodePart(clientSeed),
      encodePart(nonce),
    ]);
    getIndex = makeV2(serverSeed, transcript);
  } else {
    const rng = seedrandom(`${serverSeed}:${clientSeed}:${nonce}`);
    getIndex = (maxExclusive) => Math.floor(rng() * maxExclusive);
  }
  const numbers = Array.from({ length: tileCount }, (_, i) => i + 1);
  const drawnTiles = [];
  for (let i = 0; i < 10; i++) {
    const index = getIndex(numbers.length);
    drawnTiles.push(numbers[index]);
    numbers.splice(index, 1);
  }
  return drawnTiles;
}

// ---------------- Mines ----------------
export function minesPlacement(serverSeed, clientSeed, nonce, version, gridSize, mineCount) {
  const privateSeed = `${serverSeed}:${clientSeed}:${nonce}`;
  let getIndex;
  if (version === "hmac_sha256_v2") {
    const transcript = Buffer.concat([
      encodePart("solpump:provably-fair:hmac-sha256:v2"),
      encodePart("mines"),
      encodePart(""),
      encodePart("0"),
    ]);
    getIndex = makeV2(privateSeed, transcript);
  } else {
    const rng = seedrandom(privateSeed);
    getIndex = (maxExclusive) => Math.floor(rng() * maxExclusive);
  }
  const tileCount = gridSize * gridSize;
  const positions = Array.from({ length: tileCount }, (_, i) => i);
  const mines = [];
  for (let i = 0; i < mineCount; i++) {
    const index = getIndex(positions.length);
    mines.push(positions.splice(index, 1)[0]);
  }
  return mines;
}
