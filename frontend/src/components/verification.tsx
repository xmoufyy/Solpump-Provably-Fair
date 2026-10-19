import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Copy, FileSearch, HelpCircle, Save, ShieldQuestion, XCircle } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, FieldError, Input, Label } from "@/components/ui";
import { STATUS_LABELS, statusTone, type TraceStep, type VerificationResult } from "@/services/api";
import { cn } from "@/lib/utils";

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = statusTone(status);
  const Icon = tone === "ok" ? CheckCircle2 : tone === "bad" ? XCircle : tone === "warn" ? AlertTriangle : tone === "info" ? ShieldQuestion : HelpCircle;
  return (
    <Badge tone={tone} className={className} data-status={status}>
      <Icon className="h-3.5 w-3.5" />
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

const OVERALL_COPY: Record<string, string> = {
  verified_sufficient_evidence: "Outcome matches, commitment verified, and pre-round publication independently established.",
  match_commitment_unproven: "The recorded outcome is consistent with the revealed seeds. That the seeds were committed before the round is not proven.",
  reconstructed_only: "The outcome was calculated from the seeds, but there was no recorded outcome to compare against.",
  mismatch: "The recorded evidence does not agree with the independent calculation. Check inputs and algorithm version first.",
  incomplete: "Inputs are missing or invalid, so nothing could be verified.",
  unsupported: "The requested algorithm version is not supported.",
};

export function StatusPanel({ result }: { result: VerificationResult }) {
  const tone = statusTone(result.overall);
  const ring = { ok: "border-ok/40", bad: "border-bad/50", warn: "border-warn/40", info: "border-info/40", neutral: "border-line", accent: "border-accent/40" }[tone];
  const isReconstructedOnly = result.outcome.status === "reconstructed" || result.outcome.status === "missing_comparison";
  return (
    <Card className={cn("border-2", ring)} data-testid="status-panel">
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-widest text-muted">Overall</div>
            <div className="mt-1 flex items-center gap-2 text-lg font-semibold" data-testid="overall-status">
              {isReconstructedOnly && <span className="rounded-md bg-accent/20 px-2 py-0.5 text-sm tracking-widest text-accent-2">RECONSTRUCTED</span>}
              {STATUS_LABELS[result.overall] ?? result.overall}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted">{OVERALL_COPY[result.overall]}</p>
          </div>
          <div className="text-right text-xs text-muted">
            <div>Algorithm: <span className="font-mono text-fg">{result.algorithmVersion ?? "-"}</span></div>
            <div>Computed {new Date(result.computedAt).toLocaleString()}</div>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <StatusCell title="Outcome" status={result.outcome.status} lines={result.outcome.details} testId="outcome-status" />
          <StatusCell title="Commitment" status={result.commitment.status} lines={[result.commitment.note]} testId="commitment-status" />
          <StatusCell title="Timing evidence" status={result.timing.status} lines={[result.timing.note]} />
        </div>
        {result.commitment.candidateSha256 && result.commitment.status !== "not_supplied" && (
          <div className="rounded-lg bg-bg p-3 text-xs">
            <div className="text-muted">Candidate SHA-256(UTF-8 server seed)</div>
            <div className="font-mono break-all">{result.commitment.candidateSha256}</div>
            <div className="mt-1 text-muted">Supplied</div>
            <div className="font-mono break-all">{result.commitment.supplied}</div>
          </div>
        )}
        {result.payout && (
          <p className="rounded-lg border border-warn/30 bg-warn/5 p-3 text-xs text-warn">Payout verification unavailable: {result.payout.note}</p>
        )}
      </CardContent>
    </Card>
  );
}

function StatusCell({ title, status, lines, testId }: { title: string; status: string; lines: string[]; testId?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel-2/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-muted">{title}</span>
      </div>
      <div data-testid={testId}>
        <StatusBadge status={status} />
      </div>
      <ul className="mt-2 space-y-1 text-xs text-muted">
        {lines.filter(Boolean).map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

export function TraceView({ steps }: { steps: TraceStep[] }) {
  const [open, setOpen] = useState(true);
  const sections = useMemo(() => {
    const m = new Map<string, TraceStep[]>();
    for (const s of steps) m.set(s.section, [...(m.get(s.section) ?? []), s]);
    return [...m.entries()];
  }, [steps]);
  if (!steps.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSearch className="h-4 w-4 text-accent-2" /> Cryptographic trace
          <span className="font-normal text-muted">({steps.length} steps)</span>
        </CardTitle>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => navigator.clipboard?.writeText(JSON.stringify(steps, null, 2))}>
            <Copy className="h-3.5 w-3.5" /> Copy JSON
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
            <ChevronDown className={cn("h-4 w-4 transition-transform", !open && "-rotate-90")} />
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
                      <td className="w-64 py-1.5 pr-3 text-muted">{s.label}</td>
                      <td className="py-1.5 font-mono break-all text-fg">
                        {s.value}
                        {s.note && <div className="mt-0.5 font-sans text-muted italic">{s.note}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
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

/** Seed inputs. Values are passed through exactly as typed — never trimmed. */
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
  const ws = (s: string) => s !== s.trim();
  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="serverSeed">Server Seed (revealed)</Label>
        <Input id="serverSeed" data-testid="server-seed" value={value.serverSeed} onChange={set("serverSeed")} invalid={!!errors.serverSeed} placeholder="revealed server seed" />
        <FieldError>{errors.serverSeed}</FieldError>
        {ws(value.serverSeed) && <p className="mt-1 text-xs text-warn">Contains leading/trailing whitespace — it will be hashed as-is.</p>}
      </div>
      <div>
        <Label htmlFor="clientSeed">{clientLabel}</Label>
        <Input id="clientSeed" data-testid="client-seed" value={value.clientSeed} onChange={set("clientSeed")} invalid={!!errors.clientSeed} />
        <FieldError>{errors.clientSeed}</FieldError>
        {ws(value.clientSeed) && <p className="mt-1 text-xs text-warn">Contains leading/trailing whitespace — it will be hashed as-is.</p>}
      </div>
      {withNonce && (
        <div>
          <Label htmlFor="nonce">Nonce</Label>
          <Input id="nonce" data-testid="nonce" value={value.nonce} onChange={set("nonce")} invalid={!!errors.nonce} />
          <FieldError>{errors.nonce}</FieldError>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="roundId">Round ID (optional)</Label>
          <Input id="roundId" value={value.roundId} onChange={set("roundId")} />
        </div>
        <div>
          <Label htmlFor="commitment">Commitment (optional)</Label>
          <Input id="commitment" data-testid="commitment" value={value.commitment} onChange={set("commitment")} placeholder="server seed hash" />
        </div>
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
  for (const e of result?.errors ?? []) out[e.field.split(".")[0] === "reported" ? e.field : e.field.split(".")[0]] ??= e.message;
  return out;
}

export function VerifyBar({ onRun, onSave, busy, saved, error }: { onRun: () => void; onSave?: () => void; busy: boolean; saved: number | null; error: string | null }) {
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button className="flex-1" size="lg" onClick={onRun} disabled={busy} data-testid="verify-button">
          {busy ? "Calculating…" : "Calculate / Verify"}
        </Button>
        {onSave && (
          <Button variant="secondary" size="lg" onClick={onSave} disabled={busy} title="Save to round history" data-testid="save-button">
            <Save className="h-4 w-4" />
          </Button>
        )}
      </div>
      {saved !== null && <p className="text-xs text-ok">Saved to history as record #{saved}.</p>}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}

export function PageHeader({ title, subtitle, icon }: { title: string; subtitle?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-start gap-3">
      {icon && <div className="mt-0.5 rounded-xl bg-accent/15 p-2.5 text-accent-2">{icon}</div>}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p>}
      </div>
    </div>
  );
}
