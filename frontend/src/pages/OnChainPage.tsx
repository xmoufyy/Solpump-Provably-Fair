import { useState } from "react";
import { Link2 } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Textarea } from "@/components/ui";
import { PageHeader } from "@/components/verification";
import { api, type ChainEvidence } from "@/services/api";

export function OnChainPage() {
  const [sig, setSig] = useState("");
  const [needles, setNeedles] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ev, setEv] = useState<ChainEvidence | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setEv(null);
    try {
      setEv(await api.chainTx(sig, needles.split(/\n/).map((s) => s.trim()).filter(Boolean)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        icon={<Link2 className="h-5 w-5" />}
        title="On-Chain Evidence"
        subtitle="Read-only Solana transaction lookup. Solpump's program IDs and event formats have not been independently confirmed, so this tool does not decode Solpump-specific data. It shows generic, independently timestamped evidence and checks whether values you supply appear in the transaction. No wallet or key is ever used."
      />
      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        <Card>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="sig">Transaction signature</Label>
              <Input id="sig" value={sig} onChange={(e) => setSig(e.target.value)} placeholder="base58 signature" />
            </div>
            <div>
              <Label htmlFor="needles">Values to look for (one per line, optional)</Label>
              <Textarea id="needles" rows={4} value={needles} onChange={(e) => setNeedles(e.target.value)} placeholder={"commitment hash\npublic seed\nserver seed"} />
            </div>
            <Button className="w-full" onClick={run} disabled={busy || !sig.trim()}>{busy ? "Fetching…" : "Fetch transaction"}</Button>
            {error && <p className="text-sm text-bad">{error}</p>}
            <p className="text-xs text-muted">RPC endpoint is configured in Settings. Manual verification never needs an RPC provider.</p>
          </CardContent>
        </Card>
        {ev && (
          <Card>
            <CardHeader>
              <CardTitle>{ev.found ? "Transaction found" : "Transaction not found"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p className="rounded-lg border border-info/30 bg-info/5 p-3 text-xs text-info">{ev.caveat}</p>
              {ev.found && (
                <>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Kv k="Slot" v={ev.slot} />
                    <Kv k="Block time" v={ev.blockTimeIso ?? "—"} />
                    <Kv k="Execution" v={ev.err ? `failed: ${JSON.stringify(ev.err)}` : "success"} />
                  </div>
                  {ev.searches.length > 0 && (
                    <div>
                      <div className="mb-1 text-xs uppercase tracking-wider text-muted">Supplied values</div>
                      {ev.searches.map((s, i) => (
                        <div key={i} className="flex justify-between gap-2 border-t border-line/60 py-1.5">
                          <span className="truncate font-mono text-xs">{s.needle}</span>
                          <span className={s.foundIn.length ? "text-ok" : "text-muted"}>{s.foundIn.length ? `found in ${s.foundIn.join(", ")}` : "not found"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <List title="Programs invoked" items={ev.programIds} />
                  <List title="Memos" items={ev.memos} />
                  <List title="Log messages" items={ev.logMessages} />
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

const Kv = ({ k, v }: { k: string; v: unknown }) => (
  <div className="rounded-lg bg-panel-2 p-3">
    <div className="text-xs text-muted">{k}</div>
    <div className="font-mono text-xs break-all">{String(v)}</div>
  </div>
);
const List = ({ title, items }: { title: string; items: string[] }) => (
  <div>
    <div className="mb-1 text-xs uppercase tracking-wider text-muted">{title} ({items.length})</div>
    <pre className="max-h-64 overflow-auto rounded-lg bg-bg p-3 font-mono text-xs scrollbar-thin">{items.join("\n") || "—"}</pre>
  </div>
);
