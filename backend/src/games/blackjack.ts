import { hmacSha256Hex } from "../crypto/hmac.js";
import { Trace, type ComputeOptions } from "../types.js";
import type { GeneratedCard } from "../../../shared/src/contracts.js";

export const AVAILABLE_LABELS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;
export const AVAILABLE_SUITS = ["hearts", "diamonds", "clubs", "spades"] as const;

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

export function computeBlackjack(serverSeed: string, clientSeed: string, cardCount: number, opts: ComputeOptions = {}) {
  const trace = new Trace(opts.trace ?? true);
  trace.add("Inputs", "HMAC key", "server seed (UTF-8, unmodified)");
  trace.add("Inputs", "HMAC message", "client seed immediately followed by the decimal card number (no separator)");
  const cards: GeneratedCard[] = [];
  for (let n = 1; n <= cardCount; n++) {
    const c = generateCard(serverSeed, clientSeed, n);
    cards.push(c);
    trace.add(`Card ${n}`, "message", `clientSeed + "${n}"`);
    trace.add(`Card ${n}`, "HMAC-SHA256", c.hash);
    trace.add(`Card ${n}`, "h = parseInt(hash[0..13], 16)", String(c.h));
    trace.add(`Card ${n}`, "h % 13 -> rank", `${c.rankIndex} -> ${c.label}`);
    trace.add(`Card ${n}`, "h % 4 -> suit", `${c.suitIndex} -> ${c.suit}`);
  }
  return { cards, trace };
}
