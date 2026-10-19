import { useEffect, useState } from "react";
import { Fingerprint, Info, AlertTriangle, AlertOctagon } from "lucide-react";
import { Button, Card, CardContent } from "@/components/ui";
import { PageHeader } from "@/components/verification";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";

export function IntegrityPage({ openRound }: { openRound: (id: number) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.integrity>> | null>(null);
  const load = () => api.integrity().then(setData);
  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <PageHeader
        icon={<Fingerprint className="h-5 w-5" />}
        title="Seed Integrity"
        subtitle="Consistency checks across stored rounds: duplicates, conflicting records, nonce reuse, seed rotations, commitment and version inconsistencies. These are data anomalies to investigate — none is by itself evidence of fraud."
      />
      <div className="mb-4 flex items-center gap-3">
        <Button variant="secondary" onClick={load}>Re-run audit</Button>
        {data && <span className="text-sm text-muted">{data.checked} records checked · {data.findings.length} findings</span>}
      </div>
      <div className="space-y-3" data-testid="findings">
        {data?.findings.length === 0 && (
          <Card><CardContent className="text-sm text-muted">No anomalies found in {data.checked} records.</CardContent></Card>
        )}
        {data?.findings.map((f, i) => {
          const Icon = f.severity === "attention" ? AlertOctagon : f.severity === "warning" ? AlertTriangle : Info;
          return (
            <Card key={i} className={cn(f.severity === "attention" && "border-bad/40", f.severity === "warning" && "border-warn/40")}>
              <CardContent className="flex gap-3">
                <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", f.severity === "attention" ? "text-bad" : f.severity === "warning" ? "text-warn" : "text-info")} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{f.title}</div>
                  <p className="mt-0.5 text-sm text-muted">{f.detail}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {f.roundIds.slice(0, 40).map((id) => (
                      <button key={id} onClick={() => openRound(id)} className="cursor-pointer rounded-md bg-panel-2 px-2 py-0.5 font-mono text-xs hover:bg-tile">#{id}</button>
                    ))}
                    {f.roundIds.length > 40 && <span className="text-xs text-muted">+{f.roundIds.length - 40} more</span>}
                  </div>
                </div>
                <span className="text-xs uppercase tracking-wider text-muted">{f.check.replace(/_/g, " ")}</span>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
