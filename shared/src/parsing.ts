/** Pure text parsers used by both the importer (backend) and the forms (frontend). */
import type { Card } from "./contracts.js";

/** Parses "1, 2 3;4|5" into integers. Fails on the first token that is not a whole number. */
export function parseIntList(text: string): { values: number[]; error: string | null } {
  const tokens = text.split(/[\s,;|]+/).filter(Boolean);
  const values: number[] = [];
  for (const t of tokens) {
    if (!/^-?\d+$/.test(t)) return { values: [], error: `"${t}" is not a whole number` };
    const n = Number(t);
    if (!Number.isSafeInteger(n)) return { values: [], error: `"${t}" is out of range` };
    values.push(n);
  }
  return { values, error: null };
}

const SUITS: Record<string, string> = {
  h: "hearts", heart: "hearts", hearts: "hearts", "♥": "hearts", "♡": "hearts",
  d: "diamonds", diamond: "diamonds", diamonds: "diamonds", "♦": "diamonds", "♢": "diamonds",
  c: "clubs", club: "clubs", clubs: "clubs", "♣": "clubs", "♧": "clubs",
  s: "spades", spade: "spades", spades: "spades", "♠": "spades", "♤": "spades",
};
const RANKS: Record<string, string> = {
  "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9", "10": "10", t: "10",
  j: "J", jack: "J", q: "Q", queen: "Q", k: "K", king: "K", a: "A", ace: "A",
};
const CARD_RE = /^(10|[2-9tjqka]|jack|queen|king|ace)\s*([♠-♧]|hearts?|diamonds?|clubs?|spades?|[hdcs])$/u;

/** Parses one card such as "K♣", "Kc", "10H", "King of Clubs", "k clubs". */
export function parseCard(token: string): Card | null {
  const m = token.trim().toLowerCase().replace(/\s+of\s+/, " ").match(CARD_RE);
  if (!m) return null;
  const label = RANKS[m[1]];
  const suit = SUITS[m[2]];
  return label && suit ? { label, suit } : null;
}

/** Comma / semicolon / newline / pipe separated, or whitespace separated ("KC 7H AS"). */
export function parseCardList(text: string): { cards: Card[]; errors: string[] } {
  const tokens = text.split(/[,;\n|]+/).map((s) => s.trim()).filter(Boolean);
  const cards: Card[] = [];
  const errors: string[] = [];
  tokens.forEach((tok, i) => {
    const c = parseCard(tok);
    if (c) return void cards.push(c);
    const parts = tok.split(/\s+/).map(parseCard);
    if (parts.length > 1 && parts.every((p): p is Card => p !== null)) cards.push(...parts);
    else errors.push(`Card #${i + 1} "${tok}" could not be parsed (use e.g. K♣, Kc, 10h, Ace of spades)`);
  });
  return { cards, errors };
}

export const SUIT_SYMBOL: Record<string, string> = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };

export function summarizeOutcome(game: string, o: unknown): string {
  if (!o || typeof o !== "object") return "";
  const v = o as Record<string, unknown>;
  switch (game) {
    case "crash":
      // Never round a reported value for display: 1.254 must not appear as "1.25x" (audit F-09).
      if (typeof v.multiplier !== "number") return "";
      return Math.round(v.multiplier * 100) / 100 === v.multiplier ? `${v.multiplier.toFixed(2)}x` : `${v.multiplier}x`;
    case "blackjack": {
      const cards = v.cards as Card[] | undefined;
      return cards ? cards.map((c) => `${c.label}${c.suit[0].toUpperCase()}`).join(" ") : "";
    }
    case "keno": {
      const list = (v.drawn ?? v.draw) as number[] | undefined;
      return Array.isArray(list) ? list.join(" ") : "";
    }
    case "mines": {
      const parts: string[] = [];
      if (Array.isArray(v.mines)) parts.push(`mines ${(v.mines as number[]).join(" ")}`);
      const res = v.outcome ?? v.derivedOutcome;
      if (res) parts.push(String(res));
      return parts.join(" / ");
    }
  }
  return "";
}

/** Invisible characters by code point (numeric so this source file stays plain ASCII). */
const INVISIBLE = new Map<number, string>([
  [0x00a0, "no-break space"], [0x00ad, "soft hyphen"], [0x180e, "Mongolian vowel separator"], [0x200b, "zero-width space"],
  [0x200c, "zero-width non-joiner"], [0x200d, "zero-width joiner"], [0x200e, "left-to-right mark"], [0x200f, "right-to-left mark"],
  [0x2028, "line separator"], [0x2029, "paragraph separator"], [0x202f, "narrow no-break space"], [0x2060, "word joiner"], [0xfeff, "byte order mark"],
]);
const isBidiControl = (cp: number) => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);

/**
 * Characters in a seed that a person is unlikely to have meant: surrounding whitespace, invisible or
 * direction-changing characters, control characters. Purely advisory - the value is never modified,
 * because the exact bytes are what the casino hashed.
 */
export function seedHazards(value: string): string[] {
  const out: string[] = [];
  if (/^\s|\s$/u.test(value)) out.push("leading or trailing whitespace");
  const seen = new Map<string, number[]>();
  [...value].forEach((ch, i) => {
    const cp = ch.codePointAt(0)!;
    const named = INVISIBLE.get(cp) ?? (cp < 0x20 || cp === 0x7f ? "control character" : isBidiControl(cp) ? "bidirectional control" : null);
    if (!named) return;
    const key = `${named} (U+${cp.toString(16).toUpperCase().padStart(4, "0")})`;
    seen.set(key, [...(seen.get(key) ?? []), i + 1]);
  });
  for (const [k, pos] of seen) out.push(`${k} at position${pos.length > 1 ? "s" : ""} ${pos.slice(0, 5).join(", ")}${pos.length > 5 ? ", ..." : ""}`);
  return out;
}
