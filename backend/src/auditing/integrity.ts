import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { FindingKind, IntegrityFinding, IntegrityReport } from "../../../shared/src/contracts.js";

const MAX_IDS = 200; // per finding
const MAX_FINDINGS_PER_CHECK = 100;

/**
 * Seed-integrity checks, executed as SQL aggregations (no per-row JSON parsing).
 *
 * Findings are classified:
 *  - contradiction: the data cannot all be true under the published deterministic algorithms
 *                   (e.g. one seed context producing two different outcomes)
 *  - anomaly:       unusual but explainable (seed reuse, nonce reset, mixed versions, rotation without commitment)
 *  - data_quality:  missing or invalid evidence
 * None of these is, by itself, proof of manipulation.
 */
export function runIntegrityAudit(db: DatabaseSync): IntegrityReport {
  const findings: IntegrityFinding[] = [];
  let truncated = false;
  const checked = (db.prepare("SELECT COUNT(*) AS n FROM rounds").get() as { n: number }).n;
  const ids = (s: unknown) => String(s ?? "").split(",").filter(Boolean).slice(0, MAX_IDS).map(Number);
  const add = (f: Omit<IntegrityFinding, "roundIds" | "totalRounds"> & { idList: unknown; total: number }) => {
    const { idList, total, ...rest } = f;
    findings.push({ ...rest, roundIds: ids(idList), totalRounds: total });
  };
  const q = <T>(sql: string, ...p: SQLInputValue[]) => {
    const rows = db.prepare(`${sql} LIMIT ${MAX_FINDINGS_PER_CHECK + 1}`).all(...p) as T[];
    if (rows.length > MAX_FINDINGS_PER_CHECK) {
      truncated = true;
      rows.length = MAX_FINDINGS_PER_CHECK;
    }
    return rows;
  };
  const SEP = "char(31)";
  const ctx = `COALESCE(server_seed,'') || ${SEP} || COALESCE(client_seed,'') || ${SEP} || COALESCE(nonce,'') || ${SEP} || COALESCE(algorithm_version,'')`;
  const game = (g: string) => g.charAt(0).toUpperCase() + g.slice(1);

  // 1. Same game + round id recorded more than once
  for (const r of q<Record<string, string | number>>(
    `SELECT game, round_id, COUNT(*) AS n, COUNT(DISTINCT COALESCE(recorded_json,'')) AS outcomes,
       COUNT(DISTINCT ${ctx} || ${SEP} || COALESCE(json_extract(inputs_json,'$.difficulty'),'') || ${SEP} || COALESCE(json_extract(inputs_json,'$.gridSize'),'') || ${SEP} || COALESCE(json_extract(inputs_json,'$.mineCount'),'')) AS inputs,
       group_concat(id) AS ids
     FROM rounds WHERE round_id IS NOT NULL AND round_id <> '' GROUP BY game, round_id HAVING COUNT(*) > 1 ORDER BY n DESC`,
  )) {
    const conflicting = Number(r.outcomes) > 1 || Number(r.inputs) > 1;
    const what = [Number(r.inputs) > 1 ? "fairness inputs" : "", Number(r.outcomes) > 1 ? "recorded outcomes" : ""].filter(Boolean).join(" and ");
    add({
      check: conflicting ? "conflicting_records" : "duplicate_records",
      kind: conflicting ? "contradiction" : "data_quality",
      severity: conflicting ? "attention" : "info",
      title: conflicting ? `Conflicting records for ${game(String(r.game))} round ${r.round_id}` : `Duplicate records for ${game(String(r.game))} round ${r.round_id}`,
      detail: conflicting
        ? `${r.n} records share this round ID but differ in ${what}. At most one of them can describe the real round.`
        : `${r.n} identical records (e.g. saved twice). Imports skip exact duplicates automatically.`,
      idList: r.ids,
      total: Number(r.n),
    });
  }

  // 2. Keno/Mines: same server seed + client seed + nonce on different rounds
  for (const r of q<Record<string, string | number>>(
    `SELECT game, nonce, COUNT(DISTINCT COALESCE(round_id, '#' || id)) AS rounds, COUNT(DISTINCT COALESCE(calculated_json,'')) AS calcs,
       COUNT(DISTINCT CASE WHEN recorded_json IS NOT NULL THEN recorded_json END) AS outcomes, group_concat(id) AS ids, COUNT(*) AS n
     FROM rounds WHERE game IN ('keno','mines') AND server_seed IS NOT NULL AND nonce IS NOT NULL
     GROUP BY game, server_seed, client_seed, nonce, algorithm_version,
       json_extract(inputs_json,'$.difficulty'), json_extract(inputs_json,'$.gridSize'), json_extract(inputs_json,'$.mineCount')
     HAVING rounds > 1 ORDER BY rounds DESC`,
  )) {
    const contradiction = Number(r.outcomes) > 1;
    add({
      check: contradiction ? "nonce_reuse_conflicting_outcomes" : "nonce_reuse",
      kind: contradiction ? "contradiction" : "anomaly",
      severity: contradiction ? "attention" : "warning",
      title: `${game(String(r.game))}: nonce ${r.nonce} used by ${r.rounds} different rounds in one seed context`,
      detail: contradiction
        ? "The same seeds, nonce and settings always produce the same result, yet these records report different outcomes. They cannot all be correct."
        : "Identical seeds, nonce and settings must produce identical results; seeing several rounds for one context usually means the nonce was not incremented or rounds were mislabelled.",
      idList: r.ids,
      total: Number(r.n),
    });
  }

  // 3. Crash / Blackjack: no nonce, so a seed pair should belong to one round
  for (const r of q<Record<string, string | number>>(
    `SELECT game, COUNT(DISTINCT COALESCE(round_id, '#' || id)) AS rounds, group_concat(id) AS ids, COUNT(*) AS n
     FROM rounds WHERE game IN ('crash','blackjack') AND server_seed IS NOT NULL
     GROUP BY game, server_seed, client_seed HAVING rounds > 1 ORDER BY rounds DESC`,
  )) {
    add({
      check: "seed_pair_reuse",
      kind: "anomaly",
      severity: "warning",
      title: `${game(String(r.game))}: one seed pair used for ${r.rounds} rounds`,
      detail: "The published algorithm has no nonce, so rounds sharing a seed pair must have identical outcomes.",
      idList: r.ids,
      total: Number(r.n),
    });
  }

  // 4. Mixed algorithm versions within one seed pair
  for (const r of q<Record<string, string | number>>(
    `SELECT game, group_concat(DISTINCT algorithm_version) AS versions, group_concat(id) AS ids, COUNT(*) AS n
     FROM rounds WHERE game IN ('keno','mines') AND server_seed IS NOT NULL
     GROUP BY game, server_seed, client_seed HAVING COUNT(DISTINCT algorithm_version) > 1`,
  )) {
    add({
      check: "inconsistent_versions",
      kind: "anomaly",
      severity: "warning",
      title: `${game(String(r.game))}: mixed algorithm versions within one seed pair`,
      detail: `Versions recorded: ${r.versions}. One seed pair would normally be used with one algorithm version; check the source data.`,
      idList: r.ids,
      total: Number(r.n),
    });
  }

  // 5. Nonce going backwards within a seed pair, ordered by round timestamp
  for (const r of q<Record<string, string | number>>(
    `SELECT game, COUNT(*) AS n, group_concat(id) AS ids FROM (
       SELECT id, game, server_seed, client_seed, CAST(nonce AS INTEGER) AS nn,
         LAG(CAST(nonce AS INTEGER)) OVER (PARTITION BY game, server_seed, client_seed ORDER BY round_timestamp, id) AS prev
       FROM rounds WHERE game IN ('keno','mines') AND round_timestamp IS NOT NULL AND nonce <> '' AND nonce NOT GLOB '*[^0-9]*'
     ) WHERE prev IS NOT NULL AND nn < prev GROUP BY game, server_seed, client_seed`,
  )) {
    add({
      check: "nonce_reset",
      kind: "anomaly",
      severity: "warning",
      title: `${game(String(r.game))}: nonce decreased ${r.n} time(s) within one seed pair`,
      detail: "Ordered by recorded timestamp, the nonce went backwards without a server-seed rotation. Timestamps may be wrong, or nonces were reset.",
      idList: r.ids,
      total: Number(r.n),
    });
  }

  // 6. One commitment recorded for different server seeds (a hash commits to exactly one value)
  for (const r of q<Record<string, string | number>>(
    `SELECT commitment, COUNT(DISTINCT server_seed) AS seeds, group_concat(id) AS ids, COUNT(*) AS n
     FROM rounds WHERE commitment IS NOT NULL AND server_seed IS NOT NULL GROUP BY commitment HAVING seeds > 1`,
  )) {
    add({
      check: "reused_commitment",
      kind: "contradiction",
      severity: "attention",
      title: `One commitment recorded for ${r.seeds} different server seeds`,
      detail: `Commitment ${String(r.commitment).slice(0, 16)}... is attached to different revealed seeds. A cryptographic hash commitment can match at most one of them; at least one record is wrong.`,
      idList: r.ids,
      total: Number(r.n),
    });
  }

  // 7. Server-seed rotation without any recorded commitment for the new seed
  const rot = db
    .prepare(
      // committed seeds are materialised once (a correlated NOT EXISTS here was O(n^2): 263 s at 10k rows)
      `WITH committed AS MATERIALIZED (SELECT DISTINCT server_seed FROM rounds WHERE commitment IS NOT NULL),
       cur AS (
         SELECT id, server_seed, LAG(server_seed) OVER (PARTITION BY game, client_seed ORDER BY round_timestamp, id) AS prev
         FROM rounds WHERE round_timestamp IS NOT NULL AND server_seed IS NOT NULL AND client_seed IS NOT NULL
       )
       SELECT COUNT(*) AS n, group_concat(id) AS ids FROM cur
       WHERE prev IS NOT NULL AND prev <> server_seed AND server_seed NOT IN (SELECT server_seed FROM committed)`,
    )
    .get() as { n: number; ids: string | null };
  if (rot.n) {
    add({
      check: "rotation_without_commitment",
      kind: "anomaly",
      severity: "info",
      title: `${rot.n} server-seed rotation(s) without a recorded commitment for the new seed`,
      detail: "Rotations are normal, but without the commitment that was shown before the new seed was used, those rounds cannot be tied to a pre-round promise.",
      idList: rot.ids,
      total: rot.n,
    });
  }

  // 8-13. status-based findings, computed in ONE table scan (six separate scans cost ~3.4 s at 100k rows)
  const STATUS_CHECKS: { cond: string; check: string; kind: FindingKind; severity: IntegrityFinding["severity"]; title: (n: number) => string; detail: string }[] = [
    {
      cond: "commitment_status = 'mismatch'",
      check: "commitment_mismatch",
      kind: "contradiction",
      severity: "attention",
      title: (n) => `${n} record(s) whose revealed seed does not match the supplied commitment`,
      detail: "Under the commitment scheme confirmed in Settings, the revealed server seed does not hash to the supplied commitment.",
    },
    {
      cond: "outcome_status = 'mismatch'",
      check: "outcome_mismatch",
      kind: "contradiction",
      severity: "attention",
      title: (n) => `${n} record(s) whose recorded outcome differs from the reconstruction`,
      detail: "First confirm the algorithm version, seeds, nonce and game settings were recorded correctly; transcription errors are the most common cause.",
    },
    {
      cond: "server_seed IS NULL OR server_seed = ''",
      check: "missing_reveal",
      kind: "data_quality",
      severity: "warning",
      title: (n) => `${n} record(s) without a revealed server seed`,
      detail: "Nothing can be reconstructed until the server seed is revealed (usually after rotating seeds).",
    },
    {
      cond: "outcome_status IN ('invalid_input','unsupported_version') AND server_seed IS NOT NULL AND server_seed <> ''",
      check: "invalid_records",
      kind: "data_quality",
      severity: "warning",
      title: (n) => `${n} record(s) with invalid game parameters or unsupported versions`,
      detail: "Open a record to see which field was rejected (e.g. mine count outside the grid, unknown difficulty).",
    },
    {
      cond: "commitment_status = 'not_supplied' AND outcome_status NOT IN ('invalid_input','unsupported_version')",
      check: "missing_commitment",
      kind: "data_quality",
      severity: "info",
      title: (n) => `${n} record(s) without a commitment hash`,
      detail: "Without the server-seed hash shown before play, the record cannot show the seed was fixed in advance.",
    },
    {
      cond: "evidence_source IS NULL OR evidence_source = ''",
      check: "missing_source",
      kind: "data_quality",
      severity: "info",
      title: (n) => `${n} record(s) without an evidence source`,
      detail: "Records without a source (e.g. 'Solpump history export', 'screenshot', 'on-chain tx') are harder to audit later.",
    },
  ];
  const cols = STATUS_CHECKS.map((c, i) => `SUM(CASE WHEN ${c.cond} THEN 1 ELSE 0 END) AS n${i}, group_concat(CASE WHEN ${c.cond} THEN id END) AS ids${i}`).join(", ");
  const row = db.prepare(`SELECT ${cols} FROM rounds`).get() as Record<string, number | string | null>;
  STATUS_CHECKS.forEach((c, i) => {
    const n = Number(row[`n${i}`] ?? 0);
    if (!n) return;
    const idList = String(row[`ids${i}`] ?? "").split(",").map(Number).sort((a, b) => a - b).slice(0, MAX_IDS).join(",");
    add({ check: c.check, kind: c.kind, severity: c.severity, title: c.title(n), detail: c.detail, idList, total: n });
  });

  const order: Record<FindingKind, number> = { contradiction: 0, anomaly: 1, data_quality: 2 };
  findings.sort((a, b) => order[a.kind] - order[b.kind]);
  return { checked, findings, truncated };
}
