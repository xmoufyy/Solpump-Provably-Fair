import { useCallback, useEffect, useRef, useState } from "react";
import { FileUp, Layers, Pause, Play, Square } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Label, Segmented, Textarea } from "@/components/ui";
import { PageHeader, StatusBadge } from "@/components/verification";
import { api, type ImportJob } from "@/services/api";
import { cn } from "@/lib/utils";

const CSV_TEMPLATE = "round_id,game,algorithm_version,server_seed,client_seed,nonce,difficulty,selected_numbers,grid_size,mine_count,clicked_tiles,index_base,card_count,reported_outcome,commitment,timestamp,source";
const MAX_BYTES = 50 * 1024 * 1024;

export function BatchPage() {
  const [text, setText] = useState("");
  const [format, setFormat] = useState<"auto" | "csv" | "json" | "jsonl">("auto");
  const [filename, setFilename] = useState<string | undefined>();
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [imports, setImports] = useState<ImportJob[]>([]);
  const [reaudit, setReaudit] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const refreshImports = useCallback(() => api.imports().then(setImports).catch(() => {}), []);
  useEffect(() => {
    refreshImports();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [refreshImports]);

  const poll = useCallback(
    (id: string) => {
      api
        .importJob(id)
        .then((j) => {
          setJob(j);
          if (j.status === "running" || j.status === "paused") timer.current = window.setTimeout(() => poll(id), 400);
          else refreshImports();
        })
        .catch((e) => setError(e.message));
    },
    [refreshImports],
  );

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_BYTES) return setError(`${f.name} is ${(f.size / 1e6).toFixed(1)} MB; the limit is 50 MB per import — split the file.`);
    setFilename(f.name);
    setText(await f.text());
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (ext === "csv" || ext === "json" || ext === "jsonl") setFormat(ext);
  };

  const start = async () => {
    setError(null);
    setReaudit(null);
    try {
      const { job } = await api.startImport(text, format, filename, skipDuplicates);
      setJob(job);
      poll(job.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const control = async (action: "pause" | "resume" | "cancel") => {
    if (!job) return;
    try {
      setJob(await api.controlImport(job.id, action));
      poll(job.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const rerun = async (batch: string) => {
    const r = await api.reverifyMany({ batch });
    setReaudit(`Re-audited ${r.rounds} rounds: ${r.reproduced} reproduced exactly, ${r.statusChanged} status change(s) (previous audits kept).`);
  };

  const active = job && (job.status === "running" || job.status === "paused");
  const pct = job && job.total ? Math.min(100, Math.round((100 * job.processed) / job.total)) : 0;

  return (
    <div>
      <PageHeader
        icon={<Layers className="h-5 w-5" />}
        title="Batch Verification"
        subtitle="Import recorded Solpump rounds (CSV, JSON, JSONL or pasted). Rows are verified in the background in small transactions — you can keep using the app, pause or cancel. Keno and Mines rows must state their algorithm version; it is never guessed."
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Card>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <Label>Format</Label>
                <Segmented ariaLabel="Import format" value={format} onChange={setFormat} options={[{ value: "auto", label: "Auto" }, { value: "csv", label: "CSV" }, { value: "json", label: "JSON" }, { value: "jsonl", label: "JSONL" }]} />
              </div>
              <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line px-4 text-sm hover:border-accent/60 focus-within:ring-2 focus-within:ring-accent/60">
                <FileUp className="h-4 w-4" aria-hidden /> Choose file
                <input type="file" accept=".csv,.json,.jsonl,.txt" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} data-testid="import-file" />
              </label>
              {filename && <span className="text-xs text-muted">{filename}</span>}
              <label className="ml-auto flex items-center gap-2 text-sm">
                <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
                Skip rounds already in the database
              </label>
            </div>
            <Textarea rows={14} aria-label="Data to import" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Paste CSV / JSON / JSONL here.\n\n${CSV_TEMPLATE}`} data-testid="import-text" />
            <div className="flex flex-wrap gap-2">
              <Button onClick={start} disabled={!text || !!active} data-testid="import-button">Import &amp; verify</Button>
              <Button variant="secondary" onClick={() => (setText(""), setFilename(undefined))} disabled={!!active}>Clear</Button>
              <span className="self-center text-xs text-muted">{(text.length / 1e6).toFixed(2)} MB of 50 MB</span>
            </div>
            {error && <p className="text-sm text-bad" role="alert">{error}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Accepted columns / fields</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-muted">
            <p>Keys may be snake_case or camelCase. Seed values are used byte-for-byte (not trimmed). Give large nonces and round IDs as text so no digit is lost.</p>
            <ul className="list-disc space-y-1 pl-4">
              <li><b className="text-fg">all</b>: round_id, game, server_seed, client_seed (or public_seed), commitment, timestamp, source, tx_signature</li>
              <li><b className="text-fg">crash</b>: reported_outcome / reported_multiplier</li>
              <li><b className="text-fg">blackjack</b>: card_count, reported_outcome / reported_cards (e.g. "KC 7H AS")</li>
              <li><b className="text-fg">keno</b>: algorithm_version, nonce, difficulty (CLASSIC…EXTREME), selected_numbers, reported_outcome / reported_draw</li>
              <li><b className="text-fg">mines</b>: algorithm_version, nonce, grid_size (3–8) or tile_count, mine_count, clicked_tiles, index_base (0/1), reported_outcome (positions or win/loss)</li>
              <li>algorithm_version: <span className="font-mono">hmac_sha256_v2</span> (or v2) / <span className="font-mono">seedrandom_v1</span> (or v1, legacy)</li>
            </ul>
            <p>Lists may be separated by spaces, commas, semicolons or pipes. Exact duplicates of stored rounds are skipped, so re-importing a file is safe.</p>
          </CardContent>
        </Card>
      </div>

      {job && (
        <Card className="mt-6" data-testid="import-result">
          <CardHeader className="flex-wrap">
            <CardTitle>
              Import {job.filename ?? "(pasted)"} · {job.format.toUpperCase()} · <span data-testid="job-status">{job.status}</span>
            </CardTitle>
            <div className="flex gap-2">
              {job.status === "running" && <Button size="sm" variant="secondary" onClick={() => control("pause")} data-testid="job-pause"><Pause className="h-3.5 w-3.5" aria-hidden /> Pause</Button>}
              {job.status === "paused" && <Button size="sm" variant="secondary" onClick={() => control("resume")} data-testid="job-resume"><Play className="h-3.5 w-3.5" aria-hidden /> Resume</Button>}
              {active && <Button size="sm" variant="danger" onClick={() => control("cancel")} data-testid="job-cancel"><Square className="h-3.5 w-3.5" aria-hidden /> Cancel</Button>}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="h-2.5 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Import progress">
                <div className={cn("h-full rounded-full bg-accent transition-[width]", job.status === "failed" && "bg-bad")} style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm" aria-live="polite">
                <span>{job.processed.toLocaleString()} / {job.total.toLocaleString()} rows ({pct}%)</span>
                <span className="text-ok">{job.stored.toLocaleString()} stored</span>
                <span className="text-muted">{job.duplicates.toLocaleString()} duplicates skipped</span>
                <span className="text-bad">{job.rejected.toLocaleString()} rejected</span>
              </div>
              {job.failure && <p className="mt-2 text-sm text-bad" role="alert">{job.failure}</p>}
              {job.status === "cancelled" && <p className="mt-2 text-sm text-warn">Cancelled. The {job.stored} rows committed before cancelling are complete and kept; re-import the file later to finish (duplicates are skipped).</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(job.outcomeCounts).map(([s, n]) => (
                <a key={s} href={`#/history?batch=${job.id}&outcome=${s}`} className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs hover:border-accent/60">
                  <StatusBadge status={s} /> {n}
                </a>
              ))}
            </div>
            {!active && job.stored > 0 && (
              <div className="flex flex-wrap gap-2 text-sm">
                <a className="rounded-lg border border-line px-3 py-1.5 hover:border-accent/60" href={`#/history?batch=${job.id}`}>Inspect records</a>
                <a className="rounded-lg border border-line px-3 py-1.5 hover:border-accent/60" href={`#/history?batch=${job.id}&outcome=mismatch`} data-testid="view-mismatches">Mismatches only</a>
                <a className="rounded-lg border border-line px-3 py-1.5 hover:border-accent/60" href={api.exportUrl("csv", { batch: job.id })}>Export batch (CSV)</a>
                <a className="rounded-lg border border-line px-3 py-1.5 hover:border-accent/60" href={api.exportUrl("csv", { batch: job.id, outcome: "mismatch" })}>Export mismatches (CSV)</a>
                <Button size="sm" variant="secondary" onClick={() => rerun(job.id)}>Re-run batch with current settings</Button>
              </div>
            )}
            {reaudit && <p className="text-sm text-muted">{reaudit}</p>}
            <div>
              <div className="mb-2 text-xs uppercase tracking-wider text-muted">Rejected rows{job.errorsTruncated ? ` (first ${job.errors.length} shown)` : ""}</div>
              {job.errors.length === 0 ? (
                <p className="text-sm text-muted">None.</p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-auto text-sm scrollbar-thin" data-testid="rejected-rows">
                  {job.errors.map((r, i) => (
                    <li key={i} className="rounded-lg bg-bad/10 px-3 py-1.5 text-bad">
                      <b>Line {r.line}:</b> {r.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {imports.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Previous imports</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0 text-sm scrollbar-thin">
            <table className="w-full">
              <thead className="text-left text-xs uppercase tracking-wider text-muted">
                <tr>{["When", "File", "Status", "Rows", "Stored", "Duplicates", "Rejected", ""].map((h) => <th key={h} scope="col" className="px-4 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {imports.slice(0, 20).map((i) => (
                  <tr key={i.id} className="border-t border-line/60">
                    <td className="px-4 py-2">{new Date(i.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-2">{i.filename ?? "pasted"} <span className="text-muted">({i.format})</span></td>
                    <td className="px-4 py-2">{i.status}</td>
                    <td className="px-4 py-2">{i.total}</td>
                    <td className="px-4 py-2 text-ok">{i.stored}</td>
                    <td className="px-4 py-2 text-muted">{i.duplicates}</td>
                    <td className="px-4 py-2 text-bad">{i.rejected}</td>
                    <td className="px-4 py-2"><a className="underline" href={`#/history?batch=${i.id}`}>records</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
