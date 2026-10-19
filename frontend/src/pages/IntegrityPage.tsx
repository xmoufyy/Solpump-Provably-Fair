import { useEffect, useState } from "react";
import { AlertOctagon, AlertTriangle, Fingerprint, Info } from "lucide-react";
import { Badge, Button, Card, CardContent } from "@/components/ui";
import { PageHeader } from "@/components/verification";
import { api, type IntegrityFinding } from "@/services/api";
import { cn } from "@/lib/utils";

const KIND: Record<IntegrityFinding["kind"], { label: string; tone: "bad" | "warn" | "neutral"; help: string }> = {
  contradiction: { label: "Contradiction", tone: "bad", help: "The records cannot all be true under the published deterministic algorithms." },
  anomaly: { label: "Anomaly", tone: "warn", help: "Unusual but explainable; worth checking the source data." },
  data_quality: { label: "Data quality", tone: "neutral", help: "Missing or invalid evidence that limits what can be verified." },
};

export function IntegrityPage({ openRound }: { openRound: (id: number) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.integrity>> | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => (setBusy(true), api.integrity().then(setData).finally(() => setBusy(false)));
  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <PageHeader
        icon={<Fingerprint className="h-5 w-5" />}
        title="Seed Integrity"
        subtitle="Consistency checks across stored rounds. Contradictions mean the records cannot all be correct; anomalies are unusual but explainable. None of these is by itself evidence of manipulation — transcription errors are the most common cause."
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={load} disabled={busy}>{busy ? "Auditing…" : "Re-run audit"}</Button>
        {data && (
          <span className="text-sm text-muted">
            {data.checked} records checked · {data.findings.length} findings
            {data.truncated && " (some checks returned more groups than shown)"}
          </span>
        )}
        <div className="ml-auto flex gap-2 text-xs">
          {Object.entries(KIND).map(([k, v]) => (
            <span key={k} title={v.help}><Badge tone={v.tone}>{v.label}</Badge></span>
          ))}
        </div>
      </div>
      <div className="space-y-3" data-testid="findings">
        {data?.findings.length === 0 && <Card><CardContent className="text-sm text-muted">No anomalies found in {data.checked} records.</CardContent></Card>}
        {data?.findings.map((f, i) => {
          const Icon = f.severity === "attention" ? AlertOctagon : f.severity === "warning" ? AlertTriangle : Info;
          return (
            <Card key={i} className={cn(f.kind === "contradiction" && "border-bad/40", f.kind === "anomaly" && "border-warn/40")} data-kind={f.kind}>
              <CardContent className="flex gap-3">
                <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", f.severity === "attention" ? "text-bad" : f.severity === "warning" ? "text-warn" : "text-info")} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={KIND[f.kind].tone}>{KIND[f.kind].label}</Badge>
                    <span className="font-medium">{f.title}</span>
                  </div>
                  <p className="mt-1 text-sm text-muted">{f.detail}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {f.roundIds.slice(0, 40).map((id) => (
                      <button key={id} onClick={() => openRound(id)} className="cursor-pointer rounded-md bg-panel-2 px-2 py-0.5 font-mono text-xs hover:bg-tile" aria-label={`Open record ${id}`}>
                        #{id}
                      </button>
                    ))}
                    {f.totalRounds > 40 && <span className="text-xs text-muted">+{f.totalRounds - 40} more</span>}
                  </div>
                </div>
                <span className="hidden text-xs uppercase tracking-wider text-muted sm:block">{f.check.replace(/_/g, " ")}</span>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
