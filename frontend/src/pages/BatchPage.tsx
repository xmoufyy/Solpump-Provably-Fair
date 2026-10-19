import { useEffect, useState } from "react";
import { FileUp, Layers } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Label, Segmented, Textarea } from "@/components/ui";
import { PageHeader, StatusBadge } from "@/components/verification";
import { api } from "@/services/api";

const CSV_TEMPLATE = `round_id,game,algorithm_version,server_seed,client_seed,nonce,difficulty,selected_numbers,grid_size,mine_count,clicked_tiles,index_base,card_count,reported_outcome,commitment,timestamp,source`;

export function BatchPage({ openRound }: { openRound: (id: number) => void }) {
  const [text, setText] = useState("");
  const [format, setFormat] = useState<"auto" | "csv" | "json" | "jsonl">("auto");
  const [filename, setFilename] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.importData>> | null>(null);
  const [imports, setImports] = useState<any[]>([]);

  useEffect(() => {
    api.imports().then(setImports);
  }, [result]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFilename(f.name);
    setText(await f.text());
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (ext === "csv" || ext === "json" || ext === "jsonl") setFormat(ext);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.importData(text, format, filename));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        icon={<Layers className="h-5 w-5" />}
        title="Batch Verification"
        subtitle="Import recorded Solpump rounds (CSV, JSON, JSONL or pasted). Each row is verified independently; malformed rows are reported without discarding the rest. Keno and Mines rows must state their algorithm version — it is never guessed."
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Card>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <Label>Format</Label>
                <Segmented value={format} onChange={setFormat} options={[{ value: "auto", label: "Auto" }, { value: "csv", label: "CSV" }, { value: "json", label: "JSON" }, { value: "jsonl", label: "JSONL" }]} />
              </div>
              <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line px-4 text-sm hover:border-accent/60">
                <FileUp className="h-4 w-4" /> Choose file
                <input type="file" accept=".csv,.json,.jsonl,.txt" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} data-testid="import-file" />
              </label>
              {filename && <span className="text-xs text-muted">{filename}</span>}
            </div>
            <Textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Paste CSV / JSON / JSONL here.\n\n${CSV_TEMPLATE}`} data-testid="import-text" />
            <div className="flex gap-2">
              <Button onClick={run} disabled={busy || !text} data-testid="import-button">{busy ? "Verifying…" : "Import & verify"}</Button>
              <Button variant="secondary" onClick={() => (setText(""), setResult(null), setFilename(undefined))}>Clear</Button>
            </div>
            {error && <p className="text-sm text-bad">{error}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Accepted columns / fields</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-xs text-muted">
            <p>Keys may be snake_case or camelCase. Seed values are used byte-for-byte (not trimmed).</p>
            <ul className="list-disc space-y-1 pl-4">
              <li><b className="text-fg">all</b>: round_id, game, server_seed, client_seed (or public_seed), commitment, timestamp, source, tx_signature</li>
              <li><b className="text-fg">crash</b>: reported_outcome / reported_multiplier</li>
              <li><b className="text-fg">blackjack</b>: card_count, reported_outcome / reported_cards (e.g. "KC 7H AS")</li>
              <li><b className="text-fg">keno</b>: algorithm_version, nonce, difficulty (CLASSIC…EXTREME), selected_numbers, reported_outcome / reported_draw</li>
              <li><b className="text-fg">mines</b>: algorithm_version, nonce, grid_size (3–8) or tile_count, mine_count, clicked_tiles, index_base (0/1), reported_outcome (positions or win/loss)</li>
              <li>algorithm_version: <span className="font-mono">hmac_sha256_v2</span> (or v2) / <span className="font-mono">seedrandom_v1</span> (or v1, legacy)</li>
            </ul>
            <p>Lists may be separated by spaces, commas, semicolons or pipes.</p>
          </CardContent>
        </Card>
      </div>

      {result && (
        <Card className="mt-6" data-testid="import-result">
          <CardHeader>
            <CardTitle>Import result · {result.format.toUpperCase()}</CardTitle>
            <span className="text-sm text-muted">{result.total} rows · <span className="text-ok">{result.stored.length} stored</span> · <span className="text-bad">{result.rejected.length} rejected</span></span>
          </CardHeader>
          <CardContent className="grid gap-6 lg:grid-cols-2">
            <div className="max-h-96 overflow-auto scrollbar-thin">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted"><tr><th className="py-1">Line</th><th>Round</th><th>Game</th><th>Outcome</th><th>Overall</th></tr></thead>
                <tbody>
                  {result.stored.map((s) => (
                    <tr key={s.id} className="cursor-pointer border-t border-line/60 hover:bg-panel-2" onClick={() => openRound(s.id)}>
                      <td className="py-1.5 text-muted">{s.line}</td>
                      <td className="font-mono text-xs">{s.roundId ?? "—"}</td>
                      <td className="capitalize">{s.game}</td>
                      <td><StatusBadge status={s.outcome} /></td>
                      <td><StatusBadge status={s.overall} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <div className="mb-2 text-xs uppercase tracking-wider text-muted">Rejected rows</div>
              {result.rejected.length === 0 ? <p className="text-sm text-muted">None.</p> : (
                <ul className="space-y-1 text-sm">
                  {result.rejected.map((r, i) => <li key={i} className="rounded-lg bg-bad/10 px-3 py-1.5 text-bad"><b>Line {r.line}:</b> {r.error}</li>)}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {imports.length > 0 && (
        <Card className="mt-6">
          <CardHeader><CardTitle>Previous imports</CardTitle></CardHeader>
          <CardContent className="text-sm">
            {imports.slice(0, 10).map((i) => (
              <div key={i.id} className="flex justify-between border-t border-line/60 py-1.5 first:border-0">
                <span>{new Date(i.created_at).toLocaleString()} · {i.filename ?? "pasted"} · {i.format}</span>
                <span className="text-muted">{i.stored} stored / {i.rejected} rejected</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
