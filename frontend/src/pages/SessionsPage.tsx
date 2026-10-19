import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { Badge, Button, Card, CardContent, Select } from "@/components/ui";
import { PageHeader } from "@/components/verification";
import { api, type SeedSession } from "@/services/api";

/** Seed Session Manager: every revealed seed pair with the rounds recorded under it. */
export function SessionsPage() {
  const [game, setGame] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; sessions: SeedSession[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.sessions(game || undefined, offset).then(setData).catch((e) => setError(e.message));
  }, [game, offset]);

  return (
    <div>
      <PageHeader
        icon={<KeyRound className="h-5 w-5" />}
        title="Seed Sessions"
        subtitle="Rounds grouped by revealed seed pair (server seed + client seed). Each session shows the nonce range, algorithm versions, commitments and evidence sources recorded for it, and flags conflicts inside the session."
      />
      <div className="mb-4 flex items-center gap-3">
        <Select className="w-40" aria-label="Game" value={game} onChange={(e) => (setGame(e.target.value), setOffset(0))}>
          <option value="">All games</option>
          {["crash", "blackjack", "keno", "mines"].map((g) => <option key={g} value={g}>{g}</option>)}
        </Select>
        {data && <span className="text-sm text-muted">{data.total} seed pair(s)</span>}
      </div>
      {error && <p className="text-bad" role="alert">{error}</p>}
      <div className="space-y-3" data-testid="sessions">
        {data?.sessions.length === 0 && <Card><CardContent className="text-sm text-muted">No sessions yet — verify and save rounds, or import history.</CardContent></Card>}
        {data?.sessions.map((s) => (
          <Card key={`${s.game}|${s.serverSeed}|${s.clientSeed}`} className={s.conflicts.length ? "border-warn/40" : ""}>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="accent" className="capitalize">{s.game}</Badge>
                <span className="text-sm font-medium">{s.rounds} round(s)</span>
                {s.versions.map((v) => <Badge key={v} tone="neutral" className="font-mono">{v}</Badge>)}
                {s.conflicts.map((c) => <Badge key={c} tone="warn">{c}</Badge>)}
                <a className="ml-auto text-xs underline" href={`#/history?q=${encodeURIComponent(s.serverSeed)}`}>open rounds</a>
              </div>
              <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                <div className="truncate"><span className="text-muted">Server seed: </span><span className="font-mono">{s.serverSeed}</span></div>
                <div className="truncate"><span className="text-muted">Client seed: </span><span className="font-mono">{s.clientSeed}</span></div>
                <div><span className="text-muted">Nonce range: </span>{s.nonceMin === null ? "—" : `${s.nonceMin} – ${s.nonceMax}`}</div>
                <div><span className="text-muted">Recorded between: </span>{s.firstSeen ?? "—"} → {s.lastSeen ?? "—"}</div>
                <div><span className="text-muted">Commitments recorded: </span>{s.commitments} ({s.distinctCommitments} distinct)</div>
                <div><span className="text-muted">Sources: </span>{s.sources.join(", ") || "—"}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {data && data.total > 50 && (
        <div className="mt-4 flex gap-2">
          <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(offset - 50)}>Prev</Button>
          <Button size="sm" variant="secondary" disabled={offset + 50 >= data.total} onClick={() => setOffset(offset + 50)}>Next</Button>
        </div>
      )}
    </div>
  );
}
