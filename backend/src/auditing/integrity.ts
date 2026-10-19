import type { StoredRound } from "../database/db.js";

export type Severity = "info" | "warning" | "attention";

export interface IntegrityFinding {
  check: string;
  severity: Severity;
  title: string;
  detail: string;
  roundIds: number[];
}

/**
 * Seed-integrity checks over stored audit records.
 * Findings describe data anomalies only. None of them is, by itself, evidence of manipulation:
 * duplicates may come from re-imports, rotations are normal operator behaviour, etc.
 */
export function runIntegrityAudit(rounds: StoredRound[]): { findings: IntegrityFinding[]; checked: number } {
  const findings: IntegrityFinding[] = [];
  const group = <K>(key: (r: StoredRound) => K | null) => {
    const m = new Map<K, StoredRound[]>();
    for (const r of rounds) {
      const k = key(r);
      if (k === null) continue;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };
  const recorded = (r: StoredRound) => JSON.stringify(r.recorded ?? null);
  const inputsKey = (r: StoredRound) => JSON.stringify([r.serverSeed, r.clientSeed, r.nonce, r.algorithmVersion]);

  // 1. Duplicate / conflicting round records (same game + round id)
  for (const [key, list] of group((r) => (r.roundId ? `${r.game}|${r.roundId}` : null))) {
    if (list.length < 2) continue;
    const distinctOutcomes = new Set(list.map(recorded));
    const distinctInputs = new Set(list.map(inputsKey));
    const [game, rid] = key.split("|");
    if (distinctOutcomes.size > 1 || distinctInputs.size > 1) {
      findings.push({
        check: "conflicting_records",
        severity: "attention",
        title: `Conflicting records for ${game} round ${rid}`,
        detail: `${list.length} records share this round ID but differ in ${distinctInputs.size > 1 ? "fairness inputs" : ""}${distinctInputs.size > 1 && distinctOutcomes.size > 1 ? " and " : ""}${distinctOutcomes.size > 1 ? "recorded outcomes" : ""}.`,
        roundIds: list.map((r) => r.id),
      });
    } else {
      findings.push({
        check: "duplicate_records",
        severity: "info",
        title: `Duplicate records for ${game} round ${rid}`,
        detail: `${list.length} identical records (likely re-imported).`,
        roundIds: list.map((r) => r.id),
      });
    }
  }

  // 2. Nonce reuse within a seed context (Keno / Mines): same server+client seed+nonce on different rounds
  for (const [key, list] of group((r) =>
    (r.game === "keno" || r.game === "mines") && r.serverSeed && r.nonce !== null ? `${r.game}|${r.serverSeed}|${r.clientSeed}|${r.nonce}` : null,
  )) {
    const distinctRounds = new Set(list.map((r) => r.roundId ?? `#${r.id}`));
    if (distinctRounds.size < 2) continue;
    findings.push({
      check: "nonce_reuse",
      severity: "attention",
      title: `Nonce ${list[0].nonce} reused in one ${list[0].game} seed context`,
      detail: `${distinctRounds.size} different rounds use the same server seed, client seed and nonce, so they must have identical outcomes. Context: ${key.split("|").slice(2, 3).join("")}`,
      roundIds: list.map((r) => r.id),
    });
  }

  // 3. Crash / Blackjack: same server+public seed pair on different rounds (these games have no nonce)
  for (const [, list] of group((r) => ((r.game === "crash" || r.game === "blackjack") && r.serverSeed ? `${r.game}|${r.serverSeed}|${r.clientSeed}` : null))) {
    const distinctRounds = new Set(list.map((r) => r.roundId ?? `#${r.id}`));
    if (distinctRounds.size < 2) continue;
    findings.push({
      check: "seed_pair_reuse",
      severity: "warning",
      title: `${list[0].game} seed pair used for ${distinctRounds.size} rounds`,
      detail: "The published algorithm has no nonce, so rounds with the same seed pair produce identical outcomes.",
      roundIds: list.map((r) => r.id),
    });
  }

  // 4. Inconsistent algorithm versions for the same seed context
  for (const [, list] of group((r) => ((r.game === "keno" || r.game === "mines") && r.serverSeed ? `${r.game}|${r.serverSeed}|${r.clientSeed}` : null))) {
    const versions = new Set(list.map((r) => r.algorithmVersion));
    if (versions.size < 2) continue;
    findings.push({
      check: "inconsistent_versions",
      severity: "warning",
      title: `Mixed algorithm versions within one ${list[0].game} seed pair`,
      detail: `Versions recorded: ${[...versions].join(", ")}. A single seed pair would normally be used with one algorithm version; check the source data.`,
      roundIds: list.map((r) => r.id),
    });
  }

  // 5. Seed rotations without a recorded commitment for the new server seed (per client seed, by round timestamp)
  for (const [, list] of group((r) => (r.clientSeed && r.serverSeed && r.roundTimestamp ? `${r.game}|${r.clientSeed}` : null))) {
    const sorted = [...list].sort((a, b) => String(a.roundTimestamp).localeCompare(String(b.roundTimestamp)));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      if (prev.serverSeed === cur.serverSeed) continue;
      const hasCommit = sorted.some((r) => r.serverSeed === cur.serverSeed && r.commitmentStatus !== "not_supplied");
      if (!hasCommit) {
        findings.push({
          check: "unexplained_rotation",
          severity: "info",
          title: `Server seed rotated without a recorded commitment (${cur.game})`,
          detail: `At ${cur.roundTimestamp} the server seed changed for the same client seed, and no commitment for the new seed is recorded in this dataset.`,
          roundIds: [prev.id, cur.id],
        });
      }
    }
  }

  // 6. Commitment mismatches
  const badCommit = rounds.filter((r) => r.commitmentStatus === "mismatch");
  if (badCommit.length)
    findings.push({
      check: "commitment_mismatch",
      severity: "attention",
      title: `${badCommit.length} record(s) whose revealed seed does not match the supplied commitment`,
      detail: "Under the commitment scheme confirmed in Settings, the revealed server seed does not hash to the supplied commitment.",
      roundIds: badCommit.map((r) => r.id),
    });

  // 7. Outcome mismatches
  const mism = rounds.filter((r) => r.outcomeStatus === "mismatch");
  if (mism.length)
    findings.push({
      check: "outcome_mismatch",
      severity: "attention",
      title: `${mism.length} record(s) whose recorded outcome differs from the reconstruction`,
      detail: "Check that the correct algorithm version, seeds, nonce and game settings were recorded before drawing conclusions.",
      roundIds: mism.map((r) => r.id),
    });

  // 8. Missing source information
  const noSource = rounds.filter((r) => !r.evidenceSource);
  if (noSource.length)
    findings.push({
      check: "missing_source",
      severity: "info",
      title: `${noSource.length} record(s) without an evidence source`,
      detail: "Records without a source (e.g. 'solpump history export', 'screenshot', 'on-chain tx') are harder to audit later.",
      roundIds: noSource.map((r) => r.id),
    });

  // 9. Invalid records
  const invalid = rounds.filter((r) => r.outcomeStatus === "invalid_input" || r.outcomeStatus === "unsupported_version");
  if (invalid.length)
    findings.push({
      check: "invalid_records",
      severity: "warning",
      title: `${invalid.length} record(s) could not be reconstructed`,
      detail: "Inputs were missing, invalid or used an unsupported algorithm version.",
      roundIds: invalid.map((r) => r.id),
    });

  return { findings, checked: rounds.length };
}
