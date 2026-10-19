import type { StoredRound } from "../database/db.js";

export function summarizeOutcome(game: string, o: unknown): string {
  if (!o || typeof o !== "object") return "";
  const v = o as Record<string, unknown>;
  switch (game) {
    case "crash":
      return typeof v.multiplier === "number" ? `${v.multiplier.toFixed(2)}x` : "";
    case "blackjack": {
      const cards = v.cards as { label: string; suit: string }[] | undefined;
      return cards ? cards.map((c) => `${c.label}${c.suit[0].toUpperCase()}`).join(" ") : "";
    }
    case "keno":
      return Array.isArray(v.drawn) ? (v.drawn as number[]).join(" ") : Array.isArray(v.draw) ? (v.draw as number[]).join(" ") : "";
    case "mines": {
      const parts: string[] = [];
      if (Array.isArray(v.mines)) parts.push(`mines ${(v.mines as number[]).join(" ")}`);
      if (v.outcome) parts.push(String(v.outcome));
      else if (v.derivedOutcome) parts.push(String(v.derivedOutcome));
      return parts.join(" / ");
    }
  }
  return "";
}

export function computeStats(rounds: StoredRound[]) {
  const count = (pred: (r: StoredRound) => boolean) => rounds.filter(pred).length;
  const metrics = {
    totalRounds: rounds.length,
    reconstructed: count((r) => !["invalid_input", "unsupported_version"].includes(r.outcomeStatus)),
    matching: count((r) => r.outcomeStatus === "match"),
    mismatches: count((r) => r.outcomeStatus === "mismatch"),
    reconstructedOnly: count((r) => r.outcomeStatus === "reconstructed" || r.outcomeStatus === "missing_comparison"),
    commitmentMatches: count((r) => r.commitmentStatus === "verified"),
    commitmentMismatches: count((r) => r.commitmentStatus === "mismatch"),
    commitmentUnconfirmedScheme: count((r) => r.commitmentStatus === "scheme_unconfirmed"),
    missingCommitments: count((r) => r.commitmentStatus === "not_supplied"),
    timingUnverified: count((r) => r.timingStatus !== "pre_round_publication_verified"),
    invalidRecords: count((r) => r.outcomeStatus === "invalid_input" || r.outcomeStatus === "unsupported_version"),
  };

  const statuses = ["match", "mismatch", "reconstructed", "missing_comparison", "invalid_input", "unsupported_version"];
  const byGame = ["crash", "blackjack", "keno", "mines"].map((game) => {
    const row: Record<string, number | string> = { game };
    for (const s of statuses) row[s] = rounds.filter((r) => r.game === game && r.outcomeStatus === s).length;
    return row;
  });

  const days = new Map<string, Record<string, number>>();
  for (const r of rounds) {
    const ts = r.roundTimestamp && !Number.isNaN(Date.parse(r.roundTimestamp)) ? r.roundTimestamp : r.auditedAt;
    const day = new Date(ts).toISOString().slice(0, 10);
    const d = days.get(day) ?? { match: 0, mismatch: 0, other: 0 };
    if (r.outcomeStatus === "match") d.match++;
    else if (r.outcomeStatus === "mismatch") d.mismatch++;
    else d.other++;
    days.set(day, d);
  }
  const overTime = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));

  const overall: Record<string, number> = {};
  for (const r of rounds) overall[r.overallStatus] = (overall[r.overallStatus] ?? 0) + 1;

  return { metrics, byGame, overTime, overall };
}
