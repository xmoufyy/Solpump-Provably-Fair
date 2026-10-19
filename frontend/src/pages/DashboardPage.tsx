import { useEffect, useState } from "react";
import { LayoutDashboard, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { PageHeader } from "@/components/verification";
import { OverTimeChart, StatusByGameChart } from "@/charts/Charts";
import { api, STATUS_LABELS } from "@/services/api";
import { cn } from "@/lib/utils";

const METRICS: { key: string; label: string; tone?: string }[] = [
  { key: "totalRounds", label: "Total rounds" },
  { key: "reconstructed", label: "Independently reconstructed" },
  { key: "matching", label: "Matching outcomes", tone: "text-ok" },
  { key: "mismatches", label: "Mismatches", tone: "text-bad" },
  { key: "reconstructedOnly", label: "No recorded outcome" },
  { key: "commitmentMatches", label: "Commitment matches", tone: "text-ok" },
  { key: "commitmentMismatches", label: "Commitment mismatches", tone: "text-bad" },
  { key: "commitmentUnconfirmedScheme", label: "Commitment scheme unconfirmed", tone: "text-info" },
  { key: "missingCommitments", label: "Missing commitments" },
  { key: "timingUnverified", label: "Publication timing unverified", tone: "text-info" },
  { key: "invalidRecords", label: "Invalid records", tone: "text-warn" },
];

export function DashboardPage({ go }: { go: (r: string) => void }) {
  const [stats, setStats] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.stats().then(setStats).catch((e) => setErr(e.message));
  }, []);

  return (
    <div>
      <PageHeader
        icon={<LayoutDashboard className="h-5 w-5" />}
        title="Dashboard"
        subtitle="Summary of every round stored in the local audit database. Matching a reconstruction shows consistency with the revealed seeds — it is not, on its own, proof that the seeds were fixed before the round."
      />
      {err && <p className="text-bad">{err}</p>}
      {stats && stats.metrics.totalRounds === 0 && (
        <Card className="mb-6">
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-8 w-8 text-accent-2" />
              <div>
                <div className="font-semibold">No audit records yet</div>
                <div className="text-sm text-muted">Verify a round and save it, or import your Solpump history in Batch Verification.</div>
              </div>
            </div>
            <div className="flex gap-2 text-sm">
              {["keno", "mines", "crash", "blackjack", "batch"].map((r) => (
                <button key={r} onClick={() => go(r)} className="cursor-pointer rounded-lg border border-line px-3 py-1.5 capitalize hover:border-accent/60">
                  {r}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      {stats && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="metrics">
            {METRICS.map((m) => (
              <Card key={m.key} className="p-4">
                <div className={cn("text-3xl font-semibold tabular-nums", m.tone)}>{stats.metrics[m.key]}</div>
                <div className="mt-1 text-xs text-muted">{m.label}</div>
              </Card>
            ))}
          </div>
          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Outcome status by game</CardTitle>
              </CardHeader>
              <CardContent>
                <StatusByGameChart data={stats.byGame} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Verification over time</CardTitle>
                <span className="text-xs text-muted">by round timestamp (or audit date)</span>
              </CardHeader>
              <CardContent>
                {stats.overTime.length ? <OverTimeChart data={stats.overTime} /> : <p className="py-24 text-center text-sm text-muted">No data</p>}
              </CardContent>
            </Card>
          </div>
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Overall status breakdown</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              {Object.entries(stats.overall as Record<string, number>).map(([k, n]) => (
                <div key={k} className="rounded-xl border border-line bg-panel-2 px-4 py-2 text-sm">
                  <span className="font-semibold tabular-nums">{n}</span> <span className="text-muted">{STATUS_LABELS[k] ?? k}</span>
                </div>
              ))}
              {Object.keys(stats.overall).length === 0 && <span className="text-sm text-muted">—</span>}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
