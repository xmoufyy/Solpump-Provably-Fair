import PDFDocument from "pdfkit";
import { OVERALL_EXPLANATIONS, STATUS_LABELS, type ComparisonRow, type RoundSummary, type StoredRound } from "../../../shared/src/contracts.js";
import { summarizeOutcome } from "../../../shared/src/parsing.js";
import { APP_VERSION } from "../verification/engine.js";

const label = (s: string) => STATUS_LABELS[s] ?? s;

/* ------------------------------------------------------------------ CSV */
const CSV_COLUMNS = [
  "record_id", "round_id", "game", "algorithm_version", "nonce", "server_seed", "client_seed",
  "recorded_outcome", "calculated_outcome", "outcome_status", "commitment_status", "timing_status",
  "overall_status", "evidence_source", "round_timestamp", "audited_at", "import_batch_id",
] as const;

/**
 * Spreadsheet formula injection (audit S-03): a cell starting with = + - @ TAB or CR is executed
 * as a formula by Excel/LibreOffice. Such cells are prefixed with an apostrophe in CSV only;
 * the JSON export always keeps the exact original values.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function* csvLines(rounds: Iterable<RoundSummary>): Generator<string> {
  yield CSV_COLUMNS.join(",") + "\r\n";
  for (const r of rounds) {
    yield [
      r.id, r.roundId, r.game, r.algorithmVersion, r.nonce, r.serverSeed, r.clientSeed, r.recordedSummary, r.calculatedSummary,
      r.outcomeStatus, r.commitmentStatus, r.timingStatus, r.overallStatus, r.evidenceSource, r.roundTimestamp, r.auditedAt, r.importBatchId,
    ].map(csvCell).join(",") + "\r\n";
  }
}

/* ------------------------------------------------------------------ JSON */
export function toJson(rounds: StoredRound[], traceIncluded: boolean): string {
  return JSON.stringify(
    {
      generator: `Solpump Fairness Lab ${APP_VERSION}`,
      generatedAt: new Date().toISOString(),
      note: "'recordedEvidence' is what was supplied or imported. 'calculated' is independently reconstructed from the revealed seeds using the stated algorithm version.",
      traceIncluded,
      ...(traceIncluded ? {} : { traceNote: "Traces omitted for large exports; every trace can be regenerated from the recorded inputs (deterministic algorithms), e.g. with the per-round standalone script." }),
      rounds: rounds.map((r) => ({
        recordId: r.id,
        roundId: r.roundId,
        game: r.game,
        algorithmVersion: r.algorithmVersion,
        recordedEvidence: { inputs: r.result.inputs, reportedOutcome: r.recorded, source: r.evidenceSource, roundTimestamp: r.roundTimestamp, importBatchId: r.importBatchId },
        calculated: r.calculated,
        comparisons: r.result.comparisons,
        statuses: { outcome: r.outcomeStatus, commitment: r.commitmentStatus, timing: r.timingStatus, overall: r.overallStatus },
        comparisonDetails: r.result.outcome.details,
        commitment: r.result.commitment,
        timing: r.result.timing,
        previousAudits: r.previousAudits,
        ...(traceIncluded ? { trace: r.result.trace } : {}),
        auditedAt: r.auditedAt,
        appVersion: r.result.appVersion,
      })),
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------------ report sections (shared by HTML and PDF) */
export interface ReportSection {
  title: string;
  verdict: string;
  lines: string[];
}

export function reportSections(r: StoredRound): ReportSection[] {
  const res = r.result;
  const reconstructed = !["invalid_input", "unsupported_version"].includes(r.outcomeStatus);
  const hasReported = r.recorded !== null && Object.values(r.recorded ?? {}).some((v) => v !== null && v !== undefined);
  const c = res.commitment;
  const cand = "candidateSha256" in c ? c : null;
  return [
    {
      title: "1. Outcome reconstruction",
      verdict: reconstructed ? "Reconstructed" : label(r.outcomeStatus),
      lines: reconstructed
        ? [`Algorithm: ${r.algorithmVersion}`, `Reconstructed outcome: ${summarizeOutcome(r.game, r.calculated) || "-"}`]
        : res.outcome.details,
    },
    {
      title: "2. Outcome comparison",
      verdict: !reconstructed ? "Not possible" : hasReported ? label(r.outcomeStatus) : "No original result available",
      lines: reconstructed ? res.outcome.details : [],
    },
    {
      title: "3. Seed commitment",
      verdict: label(r.commitmentStatus),
      lines: cand
        ? [`Supplied: ${cand.supplied ?? "-"}`, `SHA-256(server seed): ${cand.candidateSha256}`, `Scheme: ${cand.scheme === "unconfirmed" ? "NOT confirmed as Solpump's scheme" : "SHA-256(UTF-8 server seed), confirmed by the user"}`, c.note]
        : [c.note],
    },
    {
      title: "4. Historical (timing) evidence",
      verdict: label(r.timingStatus),
      lines: [
        res.timing.note,
        typeof res.inputs.txSignature === "string" && res.inputs.txSignature ? `Transaction signature recorded: ${res.inputs.txSignature} (not verified as linked to this round)` : "No on-chain reference recorded.",
      ],
    },
    {
      title: "5. Final assessment",
      verdict: label(r.overallStatus),
      lines: [OVERALL_EXPLANATIONS[r.overallStatus] ?? ""],
    },
  ];
}

export const LIMITATIONS = [
  "The algorithms are transcriptions of the published reference code supplied with the project; Solpump's live documentation could not be retrieved for independent comparison (bot-verification page).",
  "A matching reconstruction proves the recorded outcome is consistent with the revealed seeds - not that the seeds were fixed before the round.",
  "Commitments and timing are only as strong as their source. Values typed in or imported after the fact do not prove pre-round publication.",
  "Keno payout tables are not verified.",
];

/* ------------------------------------------------------------------ HTML */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const statusClass = (s: string) =>
  ["match", "verified", "verified_sufficient_evidence", "Reconstructed"].includes(s) ? "ok" : ["mismatch", "commitment_mismatch"].includes(s) ? "bad" : "info";

function comparisonTable(rows: ComparisonRow[]) {
  if (!rows.length) return "";
  return `<table class="cmp"><thead><tr><th>Field</th><th>Reported</th><th>Reconstructed</th><th>Status</th></tr></thead><tbody>${rows
    .map(
      (c) =>
        `<tr class="${c.status}"><td>${esc(c.field)}</td><td class="mono">${esc(c.reported ?? "-")}</td><td class="mono">${esc(c.reconstructed ?? "-")}</td><td>${esc(c.status.replace("_", " "))}${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

export function toHtml(rounds: StoredRound[]): string {
  const body = rounds
    .map((r) => {
      const sections = reportSections(r)
        .map((s) => `<div class="sec"><h3>${esc(s.title)} <span class="pill ${statusClass(s.verdict === label(r.outcomeStatus) ? r.outcomeStatus : s.verdict)}">${esc(s.verdict)}</span></h3>${s.lines.filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join("")}</div>`)
        .join("");
      const trace = r.result.trace.map((t) => `<tr><td>${esc(t.section)}</td><td>${esc(t.label)}</td><td class="mono">${esc(t.value)}</td></tr>`).join("");
      const prov = [
        ["Evidence source", r.evidenceSource ?? "(none)"],
        ["Round timestamp (recorded)", r.roundTimestamp ?? "(none)"],
        ["Import batch", r.importBatchId ?? "manual entry"],
        ["Audited at", r.auditedAt],
        ["Verifier", `Solpump Fairness Lab ${r.result.appVersion ?? "1.0.0"}`],
        ["Previous audits", r.previousAudits.length ? r.previousAudits.map((p) => `${p.auditedAt}: ${label(p.overall)}`).join("; ") : "none"],
      ]
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
        .join("");
      return `<section>
  <h2>${esc(r.game.toUpperCase())} - round ${esc(r.roundId ?? "(no id)")} <small>record #${r.id}</small></h2>
  <div class="final ${statusClass(r.overallStatus)}">${esc(label(r.overallStatus))}</div>
  <h3>Reported vs reconstructed</h3>${comparisonTable(r.result.comparisons ?? [])}
  ${sections}
  <h3>Provenance</h3><table>${prov}</table>
  <div class="cols">
    <div><h3>Recorded evidence (supplied)</h3><pre>${esc(JSON.stringify({ inputs: r.result.inputs, reported: r.recorded }, null, 2))}</pre></div>
    <div><h3>Calculated by the Lab</h3><pre>${esc(JSON.stringify(r.calculated, null, 2))}</pre></div>
  </div>
  <p class="note">Reproduce independently: download the standalone script for record #${r.id} (Round History, "Standalone script") and run <code>node round-${r.id}.mjs</code>.</p>
  <details><summary>Cryptographic trace (${r.result.trace.length} steps)</summary><table>${trace}</table></details>
</section>`;
    })
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Solpump Fairness Lab report</title>
<style>
body{font-family:system-ui,"Segoe UI",sans-serif;background:#111015;color:#e7e3ef;max-width:1100px;margin:auto;padding:24px;line-height:1.45}
section{border:1px solid #3b3150;border-radius:12px;padding:16px 20px;margin:20px 0;background:#18161d}
h2 small{color:#9a90ad;font-weight:400}h3{margin:16px 0 6px;font-size:15px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:800px){.cols{grid-template-columns:1fr}}
pre{background:#0c0b0f;padding:10px;border-radius:8px;overflow:auto;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:12.5px}td,th{border-top:1px solid #2a2433;padding:5px 6px;vertical-align:top;text-align:left}
.mono{font-family:ui-monospace,Consolas,monospace;word-break:break-all}.note{color:#b9aecb;font-size:12.5px}
.final{display:inline-block;padding:6px 12px;border-radius:8px;font-weight:600}
.ok{background:#0f3d2e;color:#6ee7b7}.bad{background:#4a1d26;color:#fca5a5}.info{background:#1e2a4a;color:#93c5fd}
.pill{font-size:11px;padding:2px 8px;border-radius:99px;font-weight:500;margin-left:6px}
.sec{border-left:3px solid #3b3150;padding-left:10px;margin:10px 0}.sec p{margin:3px 0;font-size:13px;color:#cfc7dd}
tr.match td:last-child{color:#6ee7b7}tr.mismatch td{background:#2d1219}tr.mismatch td:last-child{color:#fca5a5}
ul.lim li{color:#b9aecb;font-size:13px}
</style></head><body>
<h1>Solpump Fairness Lab - verification report</h1>
<p>Generated ${esc(new Date().toISOString())} by Solpump Fairness Lab ${APP_VERSION}. ${rounds.length} record(s).</p>
<h3>Limitations</h3><ul class="lim">${LIMITATIONS.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
${body}</body></html>`;
}

/* ------------------------------------------------------------------ PDF */
export function toPdf(rounds: StoredRound[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: "Solpump Fairness Lab report" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    // Built-in PDF fonts are Latin-1 only; replace anything else so text never renders as garbage.
    const ascii = (s: unknown) => String(s ?? "").replace(/[^\x20-\x7e\n]/g, "?");

    doc.fontSize(18).text("Solpump Fairness Lab - verification report");
    doc.moveDown(0.3).fontSize(9).fillColor("#555").text(`Generated ${new Date().toISOString()} by Solpump Fairness Lab ${APP_VERSION}. ${rounds.length} record(s).`);
    doc.moveDown(0.3).fontSize(8);
    for (const l of LIMITATIONS) doc.text(`- ${l}`);
    for (const r of rounds) {
      doc.addPage();
      doc.fillColor("#000").fontSize(14).text(`${r.game.toUpperCase()} - round ${ascii(r.roundId ?? "(no id)")}  (record #${r.id})`);
      doc.moveDown(0.2).fontSize(11).fillColor(["mismatch", "commitment_mismatch"].includes(r.overallStatus) ? "#b91c1c" : "#1d4ed8").text(`Final assessment: ${label(r.overallStatus)}`);
      doc.moveDown(0.4).fontSize(9).fillColor("#222");
      doc.text(`Server seed: ${ascii(r.serverSeed)}`).text(`Client/public seed: ${ascii(r.clientSeed)}`).text(`Nonce: ${ascii(r.nonce ?? "-")}    Algorithm: ${ascii(r.algorithmVersion)}`);
      doc.moveDown(0.4).fontSize(10).fillColor("#000").text("Reported vs reconstructed");
      doc.fontSize(8.5).fillColor("#222");
      for (const c of r.result.comparisons ?? []) {
        doc.fillColor(c.status === "mismatch" ? "#b91c1c" : "#222").text(`${ascii(c.field)}: reported ${ascii(c.reported ?? "-")} | reconstructed ${ascii(c.reconstructed ?? "-")} [${c.status}]`);
      }
      for (const s of reportSections(r)) {
        doc.moveDown(0.4).fontSize(10).fillColor("#000").text(`${s.title} - ${s.verdict}`);
        doc.fontSize(8.5).fillColor("#333");
        for (const l of s.lines.filter(Boolean)) doc.text(ascii(l));
      }
      doc.moveDown(0.4).fontSize(10).fillColor("#000").text("Provenance");
      doc.fontSize(8.5).fillColor("#333").text(`Source: ${ascii(r.evidenceSource ?? "(none)")} | Round time: ${ascii(r.roundTimestamp ?? "(none)")} | Batch: ${ascii(r.importBatchId ?? "manual")} | Audited: ${r.auditedAt}`);
      if (r.result.trace.length) {
        doc.moveDown(0.4).fontSize(10).fillColor("#000").text("Calculation trace");
        doc.fontSize(7).fillColor("#444");
        for (const t of r.result.trace.slice(0, 80)) doc.text(`[${ascii(t.section)}] ${ascii(t.label)}: ${ascii(t.value)}`);
        if (r.result.trace.length > 80) doc.text(`... ${r.result.trace.length - 80} more steps (see JSON/HTML export)`);
      }
    }
    doc.end();
  });
}
