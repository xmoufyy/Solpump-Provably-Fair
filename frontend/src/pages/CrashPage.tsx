import { useState } from "react";
import { Rocket } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, FieldError, Input, Label } from "@/components/ui";
import { PageHeader, SeedFields, StatusPanel, TraceView, VerifyBar, emptySeeds, errorMap, seedPayload, type SeedState } from "@/components/verification";
import { useVerifier } from "@/services/useVerifier";
import { cn } from "@/lib/utils";

export function CrashPage() {
  const [seeds, setSeeds] = useState<SeedState>(emptySeeds);
  const [reportedText, setReportedText] = useState("");
  const v = useVerifier();
  const reportedNum = reportedText.trim() === "" ? null : Number(reportedText.trim().replace(/x$/i, ""));
  const reportedErr = reportedNum !== null && (!Number.isFinite(reportedNum) || reportedNum <= 0) ? "Enter a positive multiplier such as 2.47" : null;
  const input = { game: "crash", ...seedPayload(seeds, false), reported: reportedNum !== null && !reportedErr ? { multiplier: reportedNum } : null };
  const errors = errorMap(v.result);
  const stale = v.isStale(input);
  const calc = !stale ? v.result?.calculated : null;

  const m: number | undefined = calc?.multiplier;
  const color = m === undefined ? "text-muted" : m < 2 ? "text-bad" : m < 10 ? "text-accent-2" : "text-ok";

  return (
    <div>
      <PageHeader
        icon={<Rocket className="h-5 w-5" />}
        title="Crash Verification"
        subtitle="HMAC-SHA256 keyed with the server seed over the public seed. If the full digest is divisible by 20 the round crashes instantly at 1.00x; otherwise the first 52 bits set the multiplier. There is no nonce."
      />
      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <Card>
          <CardContent className="space-y-5">
            <SeedFields value={seeds} onChange={setSeeds} errors={errors} withNonce={false} clientLabel="Public Seed" />
            <div>
              <Label htmlFor="reportedMultiplier">Reported Multiplier (optional)</Label>
              <Input id="reportedMultiplier" data-testid="reported-multiplier" value={reportedText} onChange={(e) => setReportedText(e.target.value)} placeholder="e.g. 1.25" invalid={!!reportedErr} />
              <FieldError>{reportedErr}</FieldError>
            </div>
            <VerifyBar onRun={() => !reportedErr && v.run(input)} onSave={() => !reportedErr && v.run(input, true)} busy={v.busy} saved={v.saved} error={v.error} />
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card className="grid-bg overflow-hidden">
            <CardContent className="flex flex-col items-center justify-center py-14">
              <div className="text-xs uppercase tracking-[0.3em] text-muted">Calculated crash point</div>
              <div className={cn("mt-3 font-mono text-7xl font-bold tabular-nums sm:text-8xl", color)} data-testid="crash-multiplier">
                {m === undefined ? "—.——" : m.toFixed(2)}
                <span className="text-4xl">x</span>
              </div>
              {calc?.instantCrash && <div className="mt-3 rounded-full bg-bad/15 px-3 py-1 text-sm text-bad">Instant crash (digest mod 20 = 0)</div>}
              {v.result?.reported?.multiplier !== undefined && !stale && (
                <div className="mt-3 text-sm text-muted">
                  Reported: <span className="font-mono text-fg">{Number(v.result.reported.multiplier).toFixed(2)}x</span>
                </div>
              )}
            </CardContent>
          </Card>
          {stale && <p className="rounded-lg border border-warn/30 bg-warn/5 px-4 py-2 text-sm text-warn">Inputs changed since the last calculation — run Calculate / Verify again.</p>}
          {calc && (
            <Card>
              <CardHeader>
                <CardTitle>Formula</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 font-mono text-sm">
                <Line k="HMAC-SHA256(serverSeed, publicSeed)" v={calc.digest} />
                <Line k="BigInt(digest) mod 20" v={`${calc.mod20}${calc.mod20 === 0 ? "  → instant crash" : ""}`} />
                {!calc.instantCrash && (
                  <>
                    <Line k="h = parseInt(digest[0..13], 16)" v={`0x${String(calc.digest).slice(0, 13)} = ${calc.h}`} />
                    <Line k="e = 2^52" v={String(calc.e)} />
                    <Line k="floor((100·e − h) / (e − h)) / 100" v={`${calc.multiplierText}x`} />
                  </>
                )}
              </CardContent>
            </Card>
          )}
          {v.result && !stale && <StatusPanel result={v.result} />}
          {v.result && !stale && <TraceView steps={v.result.trace} />}
        </div>
      </div>
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid gap-1 border-b border-line/50 pb-2 sm:grid-cols-[320px_1fr]">
      <span className="font-sans text-muted">{k}</span>
      <span className="break-all">{v}</span>
    </div>
  );
}
