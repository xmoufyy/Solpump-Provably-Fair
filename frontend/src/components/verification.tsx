import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Copy, FileSearch, HelpCircle, Info, Save, ShieldQuestion, XCircle } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, FieldError, Input, Label } from "@/components/ui";
import { EVIDENCE_EXPLANATIONS, OVERALL_EXPLANATIONS, STATUS_LABELS, statusTone, type ComparisonRow, type TraceStep, type VerificationResult } from "@/services/api";
import { cn, seedHazards } from "@/lib/utils";

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = statusTone(status);
  const Icon = tone === "ok" ? CheckCircle2 : tone === "bad" ? XCircle : tone === "warn" ? AlertTriangle : tone === "info" ? ShieldQuestion : HelpCircle;
  return (
    <Badge tone={tone} className={className} data-status={status}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/** Side-by-side "Reported vs Reconstructed" evidence table. */
export function ComparisonTable({ rows }: { rows: ComparisonRow[] }) {
  if (!rows.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reported vs reconstructed</CardTitle>
        <span className="text-xs text-muted">reported = from the round record · reconstructed = calculated here</span>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0 scrollbar-thin">
        <table className="w-full text-sm" data-testid="comparison-table">
          <thead className="bg-panel-2/60 text-left text-xs uppercase tracking-wider text-muted">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Field</th>
              <th scope="col" className="px-4 py-2 font-medium">Reported</th>
              <th scope="col" className="px-4 py-2 font-medium">Reconstructed</th>
              <th scope="col" className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} data-status={r.status} className={cn("border-t border-line/60 align-top", r.status === "mismatch" && "bg-bad/10")}>
                <th scope="row" className="px-4 py-2 text-left font-medium">{r.field}</th>
                <td className="max-w-[340px] break-all px-4 py-2 font-mono text-xs">{r.reported ?? <span className="text-muted">—</span>}</td>
                <td className="max-w-[340px] break-all px-4 py-2 font-mono text-xs">{r.reconstructed ?? <span className="text-muted">—</span>}</td>
                <td className="px-4 py-2">
                  {r.status === "match" && <Badge tone="ok"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Match</Badge>}
                  {r.status === "mismatch" && <Badge tone="bad"><XCircle className="h-3.5 w-3.5" aria-hidden />Mismatch</Badge>}
                  {r.status === "info" && <Badge tone="neutral"><Info className="h-3.5 w-3.5" aria-hidden />Info</Badge>}
                  {r.status === "not_compared" && <Badge tone="neutral">Not compared</Badge>}
                  {r.note && <div className="mt-1 max-w-xs text-xs text-muted">{r.note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

export function StatusPanel({ result, currentAssessment }: { result: VerificationResult; currentAssessment?: { overall: string } | null }) {
  const tone = statusTone(result.overall);
  const ring = { ok: "border-ok/40", bad: "border-bad/50", warn: "border-warn/40", info: "border-info/40", neutral: "border-line", accent: "border-accent/40" }[tone];
  const isReconstructedOnly = result.outcome.status === "reconstructed" || result.outcome.status === "missing_comparison";
  const c = result.commitment;
  return (
    <Card className={cn("border-2", ring)} data-testid="status-panel">
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div aria-live="polite">
            <div className="text-xs uppercase tracking-widest text-muted">Final assessment</div>
            <div className="mt-1 flex items-center gap-2 text-lg font-semibold" data-testid="overall-status">
              {isReconstructedOnly && <span className="rounded-md bg-accent/20 px-2 py-0.5 text-sm tracking-widest text-accent-2">RECONSTRUCTED</span>}
              {STATUS_LABELS[result.overall] ?? result.overall}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted">{OVERALL_EXPLANATIONS[result.overall as keyof typeof OVERALL_EXPLANATIONS]}</p>
          </div>
          <div className="text-right text-xs text-muted">
            <div>
              Algorithm: <span className="font-mono text-fg">{result.algorithmVersion ?? "-"}</span>
            </div>
            <div>Computed {new Date(result.computedAt).toLocaleString()}</div>
          </div>
        </div>
        {currentAssessment && (
          <p className="rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs text-warn">
            With today's settings this record would be assessed as “{STATUS_LABELS[currentAssessment.overall] ?? currentAssessment.overall}”. Use “Re-audit record” to update it (the previous audit is kept).
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <StatusCell title="Outcome comparison" status={result.outcome.status} lines={result.outcome.details} testId="outcome-status" />
          <StatusCell title="Seed commitment" status={c.status} lines={[c.note]} testId="commitment-status" />
          <StatusCell title="Historical (timing) evidence" status={result.timing.status} lines={[result.timing.note]} />
        </div>
        {result.payout && <p className="rounded-lg border border-warn/30 bg-warn/5 p-3 text-xs text-warn">Payout verification unavailable: {result.payout.note}</p>}
      </CardContent>
    </Card>
  );
}

function StatusCell({ title, status, lines, testId }: { title: string; status: string; lines: string[]; testId?: string }) {
  const meaning = EVIDENCE_EXPLANATIONS[status as keyof typeof EVIDENCE_EXPLANATIONS];
  return (
    <div className="rounded-xl border border-line bg-panel-2/60 p-3">
      <div className="mb-2 text-xs uppercase tracking-wider text-muted">{title}</div>
      <div data-testid={testId}>
        <StatusBadge status={status} />
      </div>
      {meaning && (
        <dl className="mt-2 space-y-1 text-xs" data-testid={testId ? `${testId}-meaning` : undefined}>
          <dt className="sr-only">What this shows</dt>
          <dd className="text-fg/90">{meaning.shows}</dd>
          {meaning.missing && (
            <>
              <dt className="font-medium text-warn">Evidence still needed</dt>
              <dd className="text-muted">{meaning.missing}</dd>
            </>
          )}
        </dl>
      )}
      <ul className="mt-2 space-y-1 text-xs text-muted">
        {lines.filter(Boolean).map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

export function TraceView({ steps, regenerated }: { steps: TraceStep[]; regenerated?: boolean }) {
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState("");
  const [copy, setCopy] = useState<{ state: "idle" | "copied" | "failed"; count: number }>({ state: "idle", count: 0 });
  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    return f ? steps.filter((s) => `${s.section} ${s.label} ${s.value}`.toLowerCase().includes(f)) : steps;
  }, [steps, filter]);
  // Copies what is shown (the filtered steps). The result is announced; a blocked clipboard is reported, not ignored.
  const copyJson = async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(JSON.stringify(shown, null, 2));
      setCopy({ state: "copied", count: shown.length });
    } catch {
      setCopy({ state: "failed", count: 0 });
    }
    window.setTimeout(() => setCopy((c) => ({ ...c, state: "idle" })), 4000);
  };
  const sections = useMemo(() => {
    const m = new Map<string, TraceStep[]>();
    for (const s of shown) m.set(s.section, [...(m.get(s.section) ?? []), s]);
    return [...m.entries()];
  }, [shown]);
  if (!steps.length) return null;
  return (
    <Card>
      <CardHeader className="flex-wrap gap-2">
        <CardTitle className="flex items-center gap-2">
          <FileSearch className="h-4 w-4 text-accent-2" aria-hidden /> Cryptographic trace
          <span className="font-normal text-muted">({steps.length} steps{regenerated ? ", regenerated from stored inputs" : ""})</span>
        </CardTitle>
        <div className="flex flex-wrap items-center gap-1">
          <Input aria-label="Filter trace" placeholder="filter…" className="h-8 w-36 font-sans text-xs" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Button variant="ghost" size="sm" onClick={copyJson} data-testid="trace-copy">
            <Copy className="h-3.5 w-3.5" aria-hidden /> Copy JSON{filter ? ` (${shown.length} shown)` : ""}
          </Button>
          <span role="status" className={cn("text-xs", copy.state === "failed" ? "text-bad" : "text-ok")} data-testid="trace-copy-status">
            {copy.state === "copied" ? `Copied ${copy.count} step${copy.count === 1 ? "" : "s"}` : copy.state === "failed" ? "Copy failed: clipboard blocked. Select the text instead." : ""}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? "Collapse trace" : "Expand trace"}>
            <ChevronDown className={cn("h-4 w-4 transition-transform", !open && "-rotate-90")} aria-hidden />
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="max-h-[560px] space-y-4 overflow-auto scrollbar-thin" data-testid="trace">
          {sections.map(([section, items]) => (
            <div key={section}>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-accent-2">{section}</div>
              <table className="w-full text-xs">
                <tbody>
                  {items.map((s, i) => (
                    <tr key={i} className="border-t border-line/60 align-top">
                      <th scope="row" className="w-64 py-1.5 pr-3 text-left font-normal text-muted">{s.label}</th>
                      <td className="break-all py-1.5 font-mono text-fg">
                        {s.value}
                        {s.note && <div className="mt-0.5 font-sans italic text-muted">{s.note}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {sections.length === 0 && <p className="text-sm text-muted">No steps match the filter.</p>}
        </CardContent>
      )}
    </Card>
  );
}

export interface SeedState {
  serverSeed: string;
  clientSeed: string;
  nonce: string;
  commitment: string;
  roundId: string;
}
export const emptySeeds: SeedState = { serverSeed: "", clientSeed: "", nonce: "", commitment: "", roundId: "" };

/** Seed inputs. Values are passed through exactly as typed - never trimmed. */
export function SeedFields({
  value,
  onChange,
  errors,
  withNonce,
  clientLabel = "Client Seed",
}: {
  value: SeedState;
  onChange: (v: SeedState) => void;
  errors: Record<string, string>;
  withNonce: boolean;
  clientLabel?: string;
}) {
  const set = (k: keyof SeedState) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  const field = (id: keyof SeedState, label: string, testId: string, opts: { placeholder?: string; warnWs?: boolean } = {}) => {
    const hazards = opts.warnWs ? seedHazards(value[id]) : [];
    return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        data-testid={testId}
        value={value[id]}
        onChange={set(id)}
        invalid={!!errors[id]}
        placeholder={opts.placeholder}
        aria-invalid={!!errors[id]}
        aria-describedby={errors[id] ? `${id}-error` : undefined}
      />
      <FieldError id={`${id}-error`}>{errors[id]}</FieldError>
      {hazards.length > 0 && (
        <p className="mt-1 text-xs text-warn" data-testid={`${testId}-warning`}>
          <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden />
          Contains {hazards.join("; ")}. It is used exactly as typed; remove it only if Solpump's value does not contain it.
        </p>
      )}
    </div>
    );
  };
  return (
    <div className="space-y-3">
      {field("serverSeed", "Server Seed (revealed)", "server-seed", { placeholder: "revealed server seed", warnWs: true })}
      {field("clientSeed", clientLabel, "client-seed", { warnWs: true })}
      {withNonce && field("nonce", "Nonce", "nonce", { warnWs: true })}
      <div className="grid gap-3 sm:grid-cols-2">
        {field("roundId", "Round ID (optional)", "round-id")}
        {field("commitment", "Commitment (optional)", "commitment", { placeholder: "server seed hash" })}
      </div>
    </div>
  );
}

export function seedPayload(s: SeedState, withNonce: boolean) {
  return {
    serverSeed: s.serverSeed,
    clientSeed: s.clientSeed,
    ...(withNonce ? { nonce: s.nonce } : {}),
    commitment: s.commitment || null,
    roundId: s.roundId || null,
    source: "manual entry",
  };
}

export function errorMap(result: VerificationResult | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of result?.errors ?? []) {
    const key = e.field.startsWith("reported.") ? e.field.split(".").slice(0, 2).join(".") : e.field.split(".")[0];
    out[key] ??= e.message;
  }
  return out;
}

export function VerifyBar({
  onRun,
  onSave,
  busy,
  saved,
  error,
  stale = false,
}: {
  onRun: () => void;
  onSave?: () => void;
  busy: boolean;
  saved: number | null;
  error: string | null;
  /** inputs changed since the run that produced `saved`: the saved record no longer describes them */
  stale?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button className="flex-1" size="lg" onClick={onRun} disabled={busy} data-testid="verify-button">
          {busy ? "Calculating…" : "Calculate / Verify"}
        </Button>
        {onSave && (
          <Button variant="secondary" size="lg" onClick={onSave} disabled={busy} aria-label="Calculate and save to round history" title="Calculate and save to round history" data-testid="save-button">
            <Save className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </div>
      <div aria-live="polite">
        {saved !== null && (
          <p className={cn("text-xs", stale ? "text-muted" : "text-ok")}>
            {stale ? "The previous inputs were saved as " : "Saved to history as "}
            <a className="underline" href={`#/history/${saved}`}>record #{saved}</a>
            {stale ? "; the current inputs are not saved." : "."}
          </p>
        )}
        {error && <p className="text-xs text-bad" role="alert">{error}</p>}
      </div>
    </div>
  );
}

export function StaleNotice() {
  return <p className="rounded-lg border border-warn/30 bg-warn/5 px-4 py-2 text-sm text-warn">Inputs changed since the last calculation — run Calculate / Verify again.</p>;
}

export function PageHeader({ title, subtitle, icon }: { title: string; subtitle?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-start gap-3">
      {icon && <div className="mt-0.5 rounded-xl bg-accent/15 p-2.5 text-accent-2" aria-hidden>{icon}</div>}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p>}
      </div>
    </div>
  );
}
