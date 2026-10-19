import { hmacSha256Hex } from "../crypto/hmac.js";
import { Trace } from "../types.js";

export const AVAILABLE_LABELS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;
export const AVAILABLE_SUITS = ["hearts", "diamonds", "clubs", "spades"] as const;
export type CardLabel = (typeof AVAILABLE_LABELS)[number];
export type CardSuit = (typeof AVAILABLE_SUITS)[number];

export interface GeneratedCard {
  cardNumber: number;
  hash: string;
  h: number;
  rankIndex: number;
  suitIndex: number;
  label: CardLabel;
  suit: CardSuit;
}

export const MAX_BLACKJACK_CARDS = 520;

/**
 * Published Solpump Blackjack card generation - one independent HMAC per card:
 *   hash = HMAC-SHA256(key = serverSeed, message = clientSeed || String(cardNumber))
 *   h = parseInt(hash[0..13], 16); label = LABELS[h % 13]; suit = SUITS[h % 4]
 * Card numbers start at 1. No separator, no nonce, no shuffle; duplicates are possible.
 */
export function generateCard(serverSeed: string, clientSeed: string, cardNumber: number): GeneratedCard {
  const hash = hmacSha256Hex(serverSeed, clientSeed, `${cardNumber}`);
  const h = parseInt(hash.slice(0, 13), 16);
  const rankIndex = h % 13;
  const suitIndex = h % 4;
  return { cardNumber, hash, h, rankIndex, suitIndex, label: AVAILABLE_LABELS[rankIndex], suit: AVAILABLE_SUITS[suitIndex] };
}

export function computeBlackjack(serverSeed: string, clientSeed: string, cardCount: number) {
  const trace = new Trace();
  trace.add("Inputs", "HMAC key", "server seed (UTF-8, unmodified)");
  trace.add("Inputs", "HMAC message", "client seed immediately followed by the decimal card number (no separator)");
  const cards: GeneratedCard[] = [];
  for (let n = 1; n <= cardCount; n++) {
    const c = generateCard(serverSeed, clientSeed, n);
    cards.push(c);
    trace.add(`Card ${n}`, "HMAC-SHA256", c.hash);
    trace.add(`Card ${n}`, "h = parseInt(hash[0..13], 16)", String(c.h));
    trace.add(`Card ${n}`, "h % 13 -> rank", `${c.rankIndex} -> ${c.label}`);
    trace.add(`Card ${n}`, "h % 4 -> suit", `${c.suitIndex} -> ${c.suit}`);
  }
  return { cards, trace };
}

const SUIT_ALIASES: Record<string, CardSuit> = {
  h: "hearts", heart: "hearts", hearts: "hearts", "♥": "hearts", "♡": "hearts",
  d: "diamonds", diamond: "diamonds", diamonds: "diamonds", "♦": "diamonds", "♢": "diamonds",
  c: "clubs", club: "clubs", clubs: "clubs", "♣": "clubs", "♧": "clubs",
  s: "spades", spade: "spades", spades: "spades", "♠": "spades", "♤": "spades",
};
const RANK_ALIASES: Record<string, CardLabel> = {
  "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9", "10": "10", t: "10",
  j: "J", jack: "J", q: "Q", queen: "Q", k: "K", king: "K", a: "A", ace: "A",
};

/** Parses one card such as "K♣", "Kc", "10H", "King of Clubs", "k clubs". */
export function parseCard(token: string): { label: CardLabel; suit: CardSuit } | null {
  const t = token.trim().toLowerCase().replace(/\s+of\s+/, " ");
  const m = t.match(/^(10|[2-9tjqka]|jack|queen|king|ace)\s*([♠-♧]|hearts?|diamonds?|clubs?|spades?|[hdcs])$/u);
  if (!m) return null;
  const label = RANK_ALIASES[m[1]];
  const suit = SUIT_ALIASES[m[2]];
  return label && suit ? { label, suit } : null;
}

/** Parses a comma / semicolon / newline / pipe separated list of cards. */
export function parseCardList(text: string): { cards: { label: CardLabel; suit: CardSuit }[]; errors: string[] } {
  const tokens = text.split(/[,;\n|]+/).map((s) => s.trim()).filter(Boolean);
  const cards: { label: CardLabel; suit: CardSuit }[] = [];
  const errors: string[] = [];
  tokens.forEach((tok, i) => {
    const c = parseCard(tok);
    if (c) return void cards.push(c);
    // Also accept whitespace-separated lists such as "KC 7H AS" (but keep "King of Clubs" as one card).
    const parts = tok.split(/\s+/).map(parseCard);
    if (parts.length > 1 && parts.every(Boolean)) cards.push(...(parts as { label: CardLabel; suit: CardSuit }[]));
    else errors.push(`Card #${i + 1} "${tok}" could not be parsed`);
  });
  return { cards, errors };
}
