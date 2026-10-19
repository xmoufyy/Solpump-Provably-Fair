"""
Independent second-language implementation of the Solpump fairness algorithms.

Written from the algorithm descriptions only. It shares no code with the TypeScript
production verifier or the JavaScript reference copy, and it uses Python's own
hmac/hashlib instead of Node's OpenSSL bindings. The legacy `seedrandom_v1` path
is a from-scratch port of seedrandom 3.0.5's default ARC4 generator (RC4-drop[256]
keyed by `mixkey`), so it is also independent of the `seedrandom` npm package.

Protocol: reads {"cases": [...]} as JSON on stdin and writes {"results": [...]} to stdout.
Every result includes intermediate values so a harness can report the FIRST step
at which two implementations diverge.
"""
import hashlib
import hmac
import json
import math
import sys

V2_LABEL = "solpump:provably-fair:hmac-sha256:v2"
LABELS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]
SUITS = ["hearts", "diamonds", "clubs", "spades"]
BOARD = {"CLASSIC": 40, "LOW": 40, "MEDIUM": 40, "HIGH": 40, "EXTREME": 56}


def u8(s: str) -> bytes:
    return s.encode("utf-8")


# ---------------------------------------------------------------- Crash
def crash(server: str, client: str) -> dict:
    digest = hmac.new(u8(server), u8(client), hashlib.sha256).hexdigest()
    if int(digest, 16) % 20 == 0:
        return {"digest": digest, "instant": True, "h": None, "cents": 100}
    h = int(digest[:13], 16)
    e = float(2 ** 52)
    # Mirror IEEE-754 double arithmetic of the JS formula step by step.
    ratio = (100.0 * e - float(h)) / (e - float(h))
    return {"digest": digest, "instant": False, "h": h, "cents": math.floor(ratio)}


# ---------------------------------------------------------------- Blackjack
def blackjack(server: str, client: str, count: int) -> dict:
    cards = []
    for n in range(1, count + 1):
        digest = hmac.new(u8(server), u8(client) + u8(str(n)), hashlib.sha256).hexdigest()
        h = int(digest[:13], 16)
        cards.append({"hash": digest, "h": h, "label": LABELS[h % 13], "suit": SUITS[h % 4]})
    return {"cards": cards}


# ---------------------------------------------------------------- v2 generator
def enc(value: str) -> bytes:
    b = u8(value)
    return len(b).to_bytes(4, "big") + b


class HmacV2:
    def __init__(self, key: str, parts):
        self.key = u8(key)
        self.transcript = b"".join(enc(p) for p in parts)
        self.counter = 0
        self.block = b""
        self.offset = 0
        self.blocks = []

    def next_u32(self) -> int:
        if self.offset + 4 > len(self.block):
            self.block = hmac.new(self.key, self.transcript + self.counter.to_bytes(4, "big"), hashlib.sha256).digest()
            self.blocks.append(self.block.hex())
            self.counter += 1
            self.offset = 0
        v = int.from_bytes(self.block[self.offset:self.offset + 4], "big")
        self.offset += 4
        return v

    def index(self, max_exclusive: int) -> int:
        limit = 2 ** 32 - (2 ** 32 % max_exclusive)
        while True:
            v = self.next_u32()
            if v < limit:
                return v % max_exclusive


# ---------------------------------------------------------------- seedrandom 3.0.5 (ARC4) port
class SeedRandom:
    WIDTH = 256
    CHUNKS = 6
    MASK = 255
    STARTDENOM = float(256 ** 6)
    SIGNIFICANCE = float(2 ** 52)
    OVERFLOW = float(2 ** 53)

    def __init__(self, seed: str):
        # mixkey(): iterates UTF-16 code units (JS charCodeAt), smearing into a <=256-byte key.
        units = memoryview(seed.encode("utf-16-le")).cast("H").tolist()
        key = []
        smear = 0
        for j, cu in enumerate(units):
            idx = self.MASK & j
            cur = key[idx] if idx < len(key) else 0  # undefined * 19 -> NaN -> 0 under ^=
            smear ^= cur * 19
            val = self.MASK & (smear + cu)
            if idx < len(key):
                key[idx] = val
            else:
                key.append(val)
        # ARC4 key schedule
        if not key:
            key = [0]
        s = list(range(256))
        j = 0
        for i in range(256):
            t = s[i]
            j = self.MASK & (j + key[i % len(key)] + t)
            s[i] = s[j]
            s[j] = t
        self.s, self.i, self.j = s, 0, 0
        self._g(256)  # RC4-drop[256]

    def _g(self, count: int) -> int:
        r, s, i, j = 0, self.s, self.i, self.j
        for _ in range(count):
            i = self.MASK & (i + 1)
            t = s[i]
            j = self.MASK & (j + t)
            s[i] = s[j]
            s[j] = t
            r = r * self.WIDTH + s[self.MASK & (s[i] + t)]
        self.i, self.j = i, j
        return r

    def random(self) -> float:
        n = float(self._g(self.CHUNKS))
        d = self.STARTDENOM
        x = 0
        while n < self.SIGNIFICANCE:
            n = (n + x) * self.WIDTH
            d *= self.WIDTH
            x = self._g(1)
        while n >= self.OVERFLOW:
            n /= 2
            d /= 2
            x >>= 1
        return (n + x) / d

    def index(self, max_exclusive: int) -> int:
        return math.floor(self.random() * max_exclusive)


# ---------------------------------------------------------------- Keno / Mines
def keno(server, client, nonce, version, mode) -> dict:
    tiles = BOARD[mode]
    if version == "hmac_sha256_v2":
        src = HmacV2(server, [V2_LABEL, "keno", client, nonce])
    else:
        src = SeedRandom(f"{server}:{client}:{nonce}")
    numbers = list(range(1, tiles + 1))
    drawn, indices = [], []
    for _ in range(10):
        k = src.index(len(numbers))
        indices.append(k)
        drawn.append(numbers.pop(k))
    return {"indices": indices, "drawn": drawn, "blocks": getattr(src, "blocks", [])}


def mines(server, client, nonce, version, grid, count) -> dict:
    private = f"{server}:{client}:{nonce}"
    if version == "hmac_sha256_v2":
        src = HmacV2(private, [V2_LABEL, "mines", "", "0"])
    else:
        src = SeedRandom(private)
    positions = list(range(grid * grid))
    out, indices = [], []
    for _ in range(count):
        k = src.index(len(positions))
        indices.append(k)
        out.append(positions.pop(k))
    return {"indices": indices, "mines": out, "blocks": getattr(src, "blocks", [])}


def run(case: dict) -> dict:
    a = case["algo"]
    if a == "crash":
        return crash(case["serverSeed"], case["clientSeed"])
    if a == "blackjack":
        return blackjack(case["serverSeed"], case["clientSeed"], case["cardCount"])
    if a == "keno":
        return keno(case["serverSeed"], case["clientSeed"], case["nonce"], case["version"], case["difficulty"])
    if a == "mines":
        return mines(case["serverSeed"], case["clientSeed"], case["nonce"], case["version"], case["gridSize"], case["mineCount"])
    raise ValueError(f"unknown algo {a}")


if __name__ == "__main__":
    data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    results = [run(c) for c in data["cases"]]
    sys.stdout.buffer.write(json.dumps({"results": results}).encode("utf-8"))
