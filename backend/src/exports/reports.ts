import PDFDocument from "pdfkit";
import type { StoredRound } from "../database/db.js";
import { summarizeOutcome } from "../auditing/stats.js";
import { APP_VERSION } from "../verification/engine.js";

const CSV_COLUMNS = [
  "record_id", "round_id", "game", "algorithm_version", "nonce", "server_seed", "client_seed",
  "recorded_outcome", "calculated_outcome", "outcome_status", "commitment_status", "timing_status",
  "overall_status", "evidence_source", "round_timestamp", "audited_at",
] as const;

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rounds: StoredRound[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rounds) {
    lines.push(
      [
        r.id, r.roundId, r.game, r.algorithmVersion, r.nonce, r.serverSeed, r.clientSeed,
        summarizeOutcome(r.game, r.recorded), summarizeOutcome(r.game, r.calculated),
        r.outcomeStatus, r.commitmentStatus, r.timingStatus, r.overallStatus, r.evidenceSource, r.roundTimestamp, r.auditedAt,
      ].map(csvCell).join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export function toJson(rounds: StoredRound[]): string {
  return JSON.stringify(
    {
      generator: `Solpump Fairness Lab ${APP_VERSION}`,
      generatedAt: new Date().toISOString(),
      note: "'recordedEvidence' is what was supplied/imported. 'calculated' is independently reconstructed by this tool from the revealed seeds.",
      rounds: rounds.map((r) => ({
        recordId: r.id,
        roundId: r.roundId,
        game: r.game,
        algorithmVersion: r.algorithmVersion,
        recordedEvidence: { inputs: r.result.inputs, reportedOutcome: r.recorded, source: r.evidenceSource, roundTimestamp: r.roundTimestamp },
        calculated: r.calculated,
        statuses: { outcome: r.outcomeStatus, commitment: r.commitmentStatus, timing: r.timingStatus, overall: r.overallStatus },
        comparisonDetails: r.result.outcome.details,
        commitment: r.result.commitment,
        trace: r.result.trace,
        auditedAt: r.auditedAt,
        appVersion: r.result.appVersion,
      })),
    },
    null,
    2,
  );
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const STATUS_LABELS: Record<string, string> = {
  reconstructed: "Reconstructed",
  match: "Match",
  mismatch: "Mismatch",
  missing_comparison: "Missing comparison",
  invalid_input: "Invalid input",
  unsupported_version: "Unsupported version",
  verified: "Commitment verified",
  not_supplied: "No commitment supplied",
  scheme_unconfirmed: "Commitment scheme unconfirmed",
  pre_round_publication_verified: "Pre-round publication verified",
  publication_timing_unverified: "Publication timing unverified",
  verified_sufficient_evidence: "Verified with sufficient evidence",
  match_commitment_unproven: "Result matches, commitment unproven",
  reconstructed_only: "Reconstructed only",
  incomplete: "Incomplete",
  unsupported: "Unsupported",
};
const label = (s: string) => STATUS_LABELS[s] ?? s;

export function toHtml(rounds: StoredRound[]): string {
  const body = rounds
    .map((r) => {
      const inputs = r.result.inputs as Record<string, unknown>;
      const trace = r.result.trace
        .map((t) => `<tr><td>${esc(t.section)}</td><td>${esc(t.label)}</td><td class="mono">${esc(t.value)}</td></tr>`)
        .join("");
      return `<section>
  <h2>${esc(r.game.toUpperCase())} — round ${esc(r.roundId ?? "(no id)")} <small>record #${r.id}</small></h2>
  <div class="status"><b>Overall:</b> ${esc(label(r.overallStatus))} · <b>Outcome:</b> ${esc(label(r.outcomeStatus))} · <b>Commitment:</b> ${esc(label(r.commitmentStatus))} · <b>Timing:</b> ${esc(label(r.timingStatus))}</div>
  <div class="cols">
    <div><h3>Recorded evidence (supplied)</h3><pre>${esc(JSON.stringify({ inputs, reported: r.recorded, source: r.evidenceSource }, null, 2))}</pre></div>
    <div><h3>Calculated by this tool</h3><pre>${esc(JSON.stringify(r.calculated, null, 2))}</pre></div>
  </div>
  <h3>Comparison</h3><ul>${r.result.outcome.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
  <p class="note">${esc((r.result.commitment as { note?: string }).note ?? "")}</p>
  <p class="note">${esc(r.result.timing.note)}</p>
  <details><summary>Cryptographic trace (${r.result.trace.length} steps)</summary><table>${trace}</table></details>
</section>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Solpump Fairness Lab report</title>
<style>body{font-family:system-ui,sans-serif;background:#111014;color:#e7e3ef;max-width:1100px;margin:auto;padding:24px}
section{border:1px solid #3b3150;border-radius:12px;padding:16px;margin:16px 0;background:#18161d}h2 small{color:#9a90ad;font-weight:400}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}pre{background:#0c0b0f;padding:10px;border-radius:8px;overflow:auto;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:12px}td{border-top:1px solid #2a2433;padding:4px;vertical-align:top}.mono{font-family:ui-monospace,monospace;word-break:break-all}
.note{color:#b9aecb;font-size:13px}.status{background:#241d33;padding:8px;border-radius:8px}</style></head><body>
<h1>Solpump Fairness Lab — verification report</h1>
<p>Generated ${esc(new Date().toISOString())} by Solpump Fairness Lab ${APP_VERSION}. ${rounds.length} record(s).</p>
<p class="note">“Recorded evidence” is what was supplied or imported; “Calculated” is independently reconstructed from the revealed seeds using the published algorithms.
A matching reconstruction shows the outcome is consistent with the revealed seeds. It does not on its own prove the seeds were committed before the round.
Every result can be reproduced by re-running the listed algorithm version on the recorded inputs.</p>
${body}</body></html>`;
}

export function toPdf(rounds: StoredRound[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: "Solpump Fairness Lab report" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const ascii = (s: unknown) => String(s ?? "").replace(/[^\x20-\x7e\n]/g, "?");

    doc.fontSize(18).text("Solpump Fairness Lab - verification report");
    doc.moveDown(0.3).fontSize(9).fillColor("#555")
      .text(`Generated ${new Date().toISOString()} by Solpump Fairness Lab ${APP_VERSION}. ${rounds.length} record(s).`)
      .text("Recorded evidence = supplied/imported data. Calculated = independently reconstructed from revealed seeds. A match does not by itself prove pre-round commitment.");
    for (const r of rounds) {
      doc.moveDown().fillColor("#000").fontSize(13).text(`${r.game.toUpperCase()} - round ${ascii(r.roundId ?? "(no id)")}  (record #${r.id})`);
      doc.fontSize(9).fillColor("#222")
        .text(`Overall: ${label(r.overallStatus)} | Outcome: ${label(r.outcomeStatus)} | Commitment: ${label(r.commitmentStatus)} | Timing: ${label(r.timingStatus)}`)
        .text(`Algorithm: ${ascii(r.algorithmVersion)}   Nonce: ${ascii(r.nonce ?? "-")}`)
        .text(`Server seed: ${ascii(r.serverSeed)}`)
        .text(`Client/public seed: ${ascii(r.clientSeed)}`)
        .text(`RECORDED outcome: ${ascii(summarizeOutcome(r.game, r.recorded) || "(none supplied)")}`)
        .text(`CALCULATED outcome: ${ascii(summarizeOutcome(r.game, r.calculated))}`);
      for (const d of r.result.outcome.details) doc.text(`- ${ascii(d)}`);
      doc.moveDown(0.3).fontSize(7).fillColor("#444");
      for (const t of r.result.trace.slice(0, 60)) doc.text(`[${ascii(t.section)}] ${ascii(t.label)}: ${ascii(t.value)}`);
      if (r.result.trace.length > 60) doc.text(`... ${r.result.trace.length - 60} more trace steps (see JSON/HTML export)`);
    }
    doc.end();
  });
}
