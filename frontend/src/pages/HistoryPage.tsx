import { useCallback, useEffect, useState } from "react";
import { History, RefreshCw, Search, Trash2, X } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Select } from "@/components/ui";
import { PageHeader, StatusBadge, StatusPanel, TraceView } from "@/components/verification";
import { api, type StoredRound } from "@/services/api";

export function summarize(game: string, o: any): string {
  if (!o) return "—";
  if (game === "crash") return typeof o.multiplier === "number" ? `${o.multiplier.toFixed(2)}x` : "—";
  if (game === "blackjack") return o.cards ? o.cards.map((c: any) => `${c.label}${{ hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" }[c.suit as string]}`).join(" ") : "—";
  if (game === "keno") return (o.drawn ?? o.draw)?.join(" ") ?? "—";
  if (game === "mines") return [o.mines ? `mines ${o.mines.join(" ")}` : "", o.outcome ?? o.derivedOutcome ?? ""].filter(Boolean).join(" · ") || "—";
  return "—";
}

export function HistoryPage({ initialId }: { initialId?: number }) {
  const [game, setGame] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ total: number; rounds: StoredRound[] } | null>(null);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<StoredRound | null>(null);
  const [reproduced, setReproduced] = useState<boolean | null>(null);
  const PAGE = 50;

  const load = useCallback(() => {
    api.rounds({ game, status, q, limit: PAGE, offset: page * PAGE }).then(setData);
  }, [game, status, q, page]);
  useEffect(load, [load]);
  useEffect(() => {
    if (initialId) api.round(initialId).then(setOpen).catch(() => {});
  }, [initialId]);

  const reverify = async (r: StoredRound) => setReproduced((await api.reverify(r.id)).reproduced);
  const remove = async (r: StoredRound) => {
    if (!confirm(`Delete audit record #${r.id}? This removes it from the local database.`)) return;
    await api.deleteRound(r.id);
    setOpen(null);
    load();
  };

  return (
    <div>
      <PageHeader icon={<History className="h-5 w-5" />} title="Round History" subtitle="Every saved or imported round with its recorded evidence, independent reconstruction and status. Open a row to inspect the full cryptographic trace." />
      <Card>
        <CardHeader className="flex-wrap">
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <div className="relative min-w-60 flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
              <Input className="pl-8 font-sans" placeholder="Search round ID, seed, nonce, source…" value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} data-testid="history-search" />
            </div>
            <Select className="w-36" value={game} onChange={(e) => (setGame(e.target.value), setPage(0))}>
              <option value="">All games</option>
              {["crash", "blackjack", "keno", "mines"].map((g) => <option key={g} value={g}>{g}</option>)}
            </Select>
            <Select className="w-60" value={status} onChange={(e) => (setStatus(e.target.value), setPage(0))}>
              <option value="">All overall statuses</option>
              <option value="verified_sufficient_evidence">Verified with sufficient evidence</option>
              <option value="match_commitment_unproven">Result matches, commitment unproven</option>
              <option value="reconstructed_only">Reconstructed only</option>
              <option value="mismatch">Mismatch</option>
              <option value="incomplete">Incomplete</option>
              <option value="unsupported">Unsupported</option>
            </Select>
          </div>
          <span className="text-xs text-muted">{data?.total ?? 0} records</span>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0 scrollbar-thin">
          <table className="w-full text-sm" data-testid="history-table">
            <thead className="bg-panel-2/60 text-left text-xs uppercase tracking-wider text-muted">
              <tr>
                {["#", "Round ID", "Game", "Algorithm", "Nonce", "Original outcome", "Reconstructed", "Outcome", "Commitment", "Overall", "Timestamp"].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.rounds.map((r) => (
                <tr key={r.id} onClick={() => (setOpen(r), setReproduced(null))} className="cursor-pointer border-t border-line/60 hover:bg-panel-2/60">
                  <td className="px-3 py-2 text-muted">{r.id}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.roundId ?? "—"}</td>
                  <td className="px-3 py-2 capitalize">{r.game}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.algorithmVersion ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.nonce ?? "—"}</td>
                  <td className="max-w-48 truncate px-3 py-2 font-mono text-xs">{summarize(r.game, r.recorded)}</td>
                  <td className="max-w-48 truncate px-3 py-2 font-mono text-xs">{summarize(r.game, r.calculated)}</td>
                  <td className="px-3 py-2"><StatusBadge status={r.outcomeStatus} /></td>
                  <td className="px-3 py-2"><StatusBadge status={r.commitmentStatus} /></td>
                  <td className="px-3 py-2"><StatusBadge status={r.overallStatus} /></td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{r.roundTimestamp ?? new Date(r.auditedAt).toLocaleString()}</td>
                </tr>
              ))}
              {data?.rounds.length === 0 && (
                <tr><td colSpan={11} className="py-16 text-center text-muted">No records match.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
        {data && data.total > PAGE && (
          <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-xs">
            <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</Button>
            <span className="text-muted">Page {page + 1} / {Math.ceil(data.total / PAGE)}</span>
            <Button size="sm" variant="secondary" disabled={(page + 1) * PAGE >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        )}
      </Card>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setOpen(null)}>
          <div className="h-full w-full max-w-4xl overflow-y-auto bg-bg p-6 scrollbar-thin" onClick={(e) => e.stopPropagation()} data-testid="round-detail">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold capitalize">{open.game} · round {open.roundId ?? "(no id)"} <span className="text-sm text-muted">record #{open.id}</span></h2>
              <Button variant="ghost" size="icon" onClick={() => setOpen(null)} aria-label="Close"><X className="h-5 w-5" /></Button>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => reverify(open)}><RefreshCw className="h-3.5 w-3.5" /> Re-run calculation</Button>
              <a className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-xs hover:border-accent/60" href={api.exportUrl("html", { ids: String(open.id) })} target="_blank">HTML report</a>
              <a className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-xs hover:border-accent/60" href={api.exportUrl("json", { ids: String(open.id) })}>JSON</a>
              <a className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-xs hover:border-accent/60" href={api.exportUrl("pdf", { ids: String(open.id) })}>PDF</a>
              <Button variant="danger" size="sm" onClick={() => remove(open)}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
              {reproduced !== null && (
                <span className={reproduced ? "self-center text-sm text-ok" : "self-center text-sm text-bad"}>
                  {reproduced ? "Re-calculation reproduced the stored result exactly." : "Re-calculation differs from the stored result!"}
                </span>
              )}
            </div>
            <div className="mb-4 grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader><CardTitle>Recorded evidence (supplied)</CardTitle></CardHeader>
                <CardContent><pre className="overflow-auto font-mono text-xs scrollbar-thin">{JSON.stringify({ inputs: open.result.inputs, reported: open.recorded }, null, 2)}</pre></CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Calculated by this tool</CardTitle></CardHeader>
                <CardContent><pre className="max-h-96 overflow-auto font-mono text-xs scrollbar-thin">{JSON.stringify(open.calculated, null, 2)}</pre></CardContent>
              </Card>
            </div>
            <div className="space-y-4">
              <StatusPanel result={open.result} />
              <TraceView steps={open.result.trace} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
