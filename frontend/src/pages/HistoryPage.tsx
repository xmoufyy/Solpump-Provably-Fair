import { useEffect, useRef, useState } from "react";
import { Download, FileCode2, History, RefreshCw, Search, Trash2, X } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Select } from "@/components/ui";
import { ComparisonTable, PageHeader, StatusBadge, StatusPanel, TraceView } from "@/components/verification";
import { api, STATUS_LABELS, type RoundFilter, type RoundSummary, type StoredRound } from "@/services/api";

const PAGE = 50;
const OVERALL = ["verified_sufficient_evidence", "match_commitment_unproven", "reconstructed_only", "mismatch", "commitment_mismatch", "incomplete", "unsupported"];
const OUTCOMES = ["match", "mismatch", "reconstructed", "missing_comparison", "invalid_input", "unsupported_version"];

export function HistoryPage({ initialId, params }: { initialId?: number; params: URLSearchParams }) {
  const [filter, setFilter] = useState<RoundFilter>({ game: params.get("game") ?? "", status: params.get("status") ?? "", outcome: params.get("outcome") ?? "", batch: params.get("batch") ?? "", q: "" });
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; rounds: RoundSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(initialId ?? null);
  const [reload, setReload] = useState(0);

  // Debounced, abortable search: a slow response can never overwrite a newer one.
  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api
        .rounds({ ...filter, limit: PAGE, offset: page * PAGE }, ctrl.signal)
        .then((d) => (setData(d), setError(null)))
        .catch((e) => e.name !== "AbortError" && setError(e.message));
    }, 200);
    return () => (clearTimeout(t), ctrl.abort());
  }, [filter, page, reload]);

  const set = (k: keyof RoundFilter) => (v: string) => (setFilter({ ...filter, [k]: v }), setPage(0));

  return (
    <div>
      <PageHeader icon={<History className="h-5 w-5" />} title="Round History" subtitle="Every saved or imported round with its recorded evidence, independent reconstruction and status. Open a row to inspect the full cryptographic trace." />
      <Card>
        <CardHeader className="flex-wrap">
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <div className="relative min-w-60 flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted" aria-hidden />
              <Input className="pl-8 font-sans" aria-label="Search history" placeholder="Search round ID, seed, nonce, source…" value={filter.q} onChange={(e) => set("q")(e.target.value)} data-testid="history-search" />
            </div>
            <Select className="w-36" aria-label="Game" value={filter.game} onChange={(e) => set("game")(e.target.value)}>
              <option value="">All games</option>
              {["crash", "blackjack", "keno", "mines"].map((g) => <option key={g} value={g}>{g}</option>)}
            </Select>
            <Select className="w-52" aria-label="Outcome status" value={filter.outcome} onChange={(e) => set("outcome")(e.target.value)} data-testid="history-outcome">
              <option value="">All outcomes</option>
              {OUTCOMES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </Select>
            <Select className="w-64" aria-label="Final assessment" value={filter.status} onChange={(e) => set("status")(e.target.value)}>
              <option value="">All final assessments</option>
              {OVERALL.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </Select>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            {filter.batch && (
              <button className="cursor-pointer rounded-md border border-line px-2 py-1 hover:border-accent/60" onClick={() => set("batch")("")}>
                import {filter.batch.slice(0, 8)}… ✕
              </button>
            )}
            <span data-testid="history-total">{data?.total ?? 0} records</span>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0 scrollbar-thin">
          {error && <p className="p-4 text-sm text-bad" role="alert">{error}</p>}
          <table className="w-full text-sm" data-testid="history-table">
            <caption className="sr-only">Audit records</caption>
            <thead className="bg-panel-2/60 text-left text-xs uppercase tracking-wider text-muted">
              <tr>
                {["#", "Round ID", "Game", "Algorithm", "Nonce", "Original outcome", "Reconstructed", "Outcome", "Commitment", "Final assessment", "Timestamp"].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap px-3 py-2.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.rounds.map((r) => (
                <tr key={r.id} className="cursor-pointer border-t border-line/60 hover:bg-panel-2/60 focus-within:bg-panel-2/60" onClick={() => setOpenId(r.id)}>
                  <td className="px-3 py-2">
                    <button className="cursor-pointer text-muted underline-offset-2 hover:underline" onClick={(e) => (e.stopPropagation(), setOpenId(r.id))} aria-label={`Open record ${r.id}`}>
                      {r.id}
                    </button>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.roundId ?? "—"}</td>
                  <td className="px-3 py-2 capitalize">{r.game}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.algorithmVersion ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.nonce ?? "—"}</td>
                  <td className="max-w-48 truncate px-3 py-2 font-mono text-xs" title={r.recordedSummary}>{r.recordedSummary || "—"}</td>
                  <td className="max-w-48 truncate px-3 py-2 font-mono text-xs" title={r.calculatedSummary}>{r.calculatedSummary || "—"}</td>
                  <td className="px-3 py-2"><StatusBadge status={r.outcomeStatus} /></td>
                  <td className="px-3 py-2"><StatusBadge status={r.commitmentStatus} /></td>
                  <td className="px-3 py-2"><StatusBadge status={r.overallStatus} /></td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{r.roundTimestamp ?? new Date(r.auditedAt).toLocaleString()}</td>
                </tr>
              ))}
              {data?.rounds.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-16 text-center text-muted">No records match.</td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
        {data && data.total > PAGE && (
          <nav className="flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-xs" aria-label="Pagination">
            <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</Button>
            <span className="text-muted">Page {page + 1} / {Math.ceil(data.total / PAGE)}</span>
            <Button size="sm" variant="secondary" disabled={(page + 1) * PAGE >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
          </nav>
        )}
      </Card>
      {openId !== null && <RoundDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => setReload((x) => x + 1)} />}
    </div>
  );
}

function RoundDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const [r, setR] = useState<StoredRound | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const load = () => api.round(id).then(setR).catch((e) => setError(e.message));

  useEffect(() => {
    load();
    const prev = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => (window.removeEventListener("keydown", onKey), prev?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const reaudit = async () => {
    const res = await api.reverify(id, true);
    setMsg(res.reproduced ? "Re-audited with current settings; the previous audit is kept in the history below." : "Re-audited, but the recalculation did NOT reproduce the stored outcome!");
    onChanged();
    load();
  };
  const remove = async () => {
    if (!confirm(`Delete audit record #${id}? This removes it from the local database (an export or backup first is recommended).`)) return;
    await api.deleteRound(id);
    onChanged();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="round-detail-title"
        className="h-full w-full max-w-5xl overflow-y-auto bg-bg p-6 outline-none scrollbar-thin"
        onClick={(e) => e.stopPropagation()}
        data-testid="round-detail"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="round-detail-title" className="text-xl font-semibold">
            {/* only the game name is capitalised; round IDs are shown exactly as recorded */}
            {r ? (
              <>
                <span className="capitalize">{r.game}</span> · round <span className="font-mono">{r.roundId ?? "(no id)"}</span>
              </>
            ) : (
              "Loading…"
            )}{" "}
            <span className="text-sm text-muted">record #{id}</span>
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close (Esc)">
            <X className="h-5 w-5" aria-hidden />
          </Button>
        </div>
        {error && <p className="text-bad" role="alert">{error}</p>}
        {r && (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={reaudit} data-testid="reaudit">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Re-audit record
              </Button>
              <a className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-xs hover:border-accent/60" href={api.scriptUrl(id)} data-testid="script-link">
                <FileCode2 className="h-3.5 w-3.5" aria-hidden /> Standalone script
              </a>
              {(["html", "pdf", "json"] as const).map((f) => (
                <a key={f} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-xs uppercase hover:border-accent/60" href={api.exportUrl(f, { ids: String(id) })} target={f === "html" ? "_blank" : undefined} rel="noreferrer">
                  <Download className="h-3.5 w-3.5" aria-hidden /> {f}
                </a>
              ))}
              <Button variant="danger" size="sm" onClick={remove}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
              </Button>
            </div>
            <div className="mb-4 space-y-1 text-sm" aria-live="polite">
              {r.reproduced !== null && (
                <p className={r.reproduced ? "text-ok" : "text-bad"} data-testid="reproduced">
                  {r.reproduced ? "✓ Recomputing from the stored inputs reproduces the stored outcome exactly." : "✗ Recomputing from the stored inputs does NOT reproduce the stored outcome."}
                </p>
              )}
              {msg && <p className="text-muted">{msg}</p>}
              <p className="text-xs text-muted">
                Reproduce without this app: download the standalone script and run <code className="rounded bg-panel-2 px-1">node round-{id}.mjs</code>.
              </p>
            </div>
            <div className="space-y-4">
              <ComparisonTable rows={r.result.comparisons} />
              <StatusPanel result={r.result} currentAssessment={r.currentAssessment} />
              <div className="grid gap-4 md:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Recorded evidence (supplied)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <pre className="overflow-auto font-mono text-xs scrollbar-thin">{JSON.stringify({ inputs: r.result.inputs, reported: r.recorded }, null, 2)}</pre>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Calculated by the Lab</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <pre className="max-h-96 overflow-auto font-mono text-xs scrollbar-thin">{JSON.stringify(r.calculated, null, 2)}</pre>
                  </CardContent>
                </Card>
              </div>
              <Card>
                <CardHeader>
                  <CardTitle>Provenance</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
                  <div><span className="text-muted">Evidence source: </span>{r.evidenceSource ?? "—"}</div>
                  <div><span className="text-muted">Round timestamp: </span>{r.roundTimestamp ?? "—"}</div>
                  <div><span className="text-muted">Import batch: </span>{r.importBatchId ? <a className="underline" href={`#/history?batch=${r.importBatchId}`}>{r.importBatchId.slice(0, 8)}…</a> : "manual entry"}</div>
                  <div><span className="text-muted">Audited: </span>{new Date(r.auditedAt).toLocaleString()} (Lab {r.result.appVersion})</div>
                  <div className="sm:col-span-2">
                    <span className="text-muted">Previous audits: </span>
                    {r.previousAudits.length ? r.previousAudits.map((p) => `${new Date(p.auditedAt).toLocaleString()} — ${STATUS_LABELS[p.overall] ?? p.overall} (v${p.appVersion})`).join("; ") : "none"}
                  </div>
                </CardContent>
              </Card>
              <TraceView steps={r.result.trace} regenerated={r.traceRegenerated} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
