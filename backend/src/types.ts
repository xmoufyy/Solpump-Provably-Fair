export {
  ALGORITHM_VERSIONS,
  BLACKJACK_VERSION,
  CRASH_VERSION,
  GAMES,
  type AlgorithmVersion,
  type Game,
  type TraceStep,
} from "../../shared/src/contracts.js";
import type { TraceStep } from "../../shared/src/contracts.js";

/**
 * Collects human-readable calculation steps. When disabled (batch imports) every
 * add() is a no-op so no strings are built; the trace can be regenerated later
 * from the stored inputs because every algorithm is deterministic.
 */
export class Trace {
  readonly steps: TraceStep[] = [];
  constructor(readonly enabled = true) {}
  add(section: string, label: string, value: unknown, note?: string) {
    if (!this.enabled) return this;
    this.steps.push({
      section,
      label,
      value: typeof value === "string" ? value : JSON.stringify(value),
      ...(note ? { note } : {}),
    });
    return this;
  }
}

export interface ComputeOptions {
  /** build the human-readable trace (default true) */
  trace?: boolean;
}
