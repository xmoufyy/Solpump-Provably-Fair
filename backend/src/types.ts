export type Game = "crash" | "blackjack" | "keno" | "mines";
export const GAMES: Game[] = ["crash", "blackjack", "keno", "mines"];
export type AlgorithmVersion = "hmac_sha256_v2" | "seedrandom_v1";
export const ALGORITHM_VERSIONS: AlgorithmVersion[] = ["hmac_sha256_v2", "seedrandom_v1"];

/** Crash and Blackjack each have exactly one published algorithm. */
export const CRASH_VERSION = "crash_hmac_sha256_v1" as const;
export const BLACKJACK_VERSION = "blackjack_hmac_sha256_card_v1" as const;

export interface TraceStep {
  section: string;
  label: string;
  value: string;
  note?: string;
}

export class Trace {
  steps: TraceStep[] = [];
  add(section: string, label: string, value: unknown, note?: string) {
    this.steps.push({
      section,
      label,
      value: typeof value === "string" ? value : JSON.stringify(value),
      ...(note ? { note } : {}),
    });
    return this;
  }
}
