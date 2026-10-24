import { useState } from "react";
import { Rocket, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, FieldError, Input, Label } from "@/components/ui";
import { ComparisonTable, PageHeader, SeedFields, StaleNotice, StatusPanel, TraceView, VerifyBar, emptySeeds, errorMap, seedPayload, type SeedState } from "@/components/verification";
import { useVerifier } from "@/services/useVerifier";
import { cn } from "@/lib/utils";

export function CrashPage() {
  const [seeds, setSeeds] = useState<SeedState>(emptySeeds);
  const [reportedText, setReportedText] = useState("");
  const v = useVerifier<"crash">();
  const trimmed = reportedText.trim().replace(/x$/i, "");
  const reportedNum = trimmed === "" ? null : Number(trimmed);
  const reportedErr = reportedNum !== null && (!/^\d+(\.\d+)?$/.test(trimmed) || reportedNum <= 0) ? "Enter a positive multiplier such as 2.47" : null;
  const input = { game: "crash", ...seedPayload(seeds, false), reported: reportedNum !== null && !reportedErr ? { multiplier: reportedNum } : null };
  const errors = errorMap(v.result);
  const stale = v.isStale(input);
  const calc = !stale ? v.result?.calculated : null;

  const m = calc?.multiplier;
  const color = m === undefined ? "text-muted" : m < 2 ? "text-bad" : m < 10 ? "text-accent-2" : "text-ok";

  return (
    <div>
      <PageHeader
        icon={<Rocket className="h-5 w-5" />}
        title="Crash Verification"
        subtitle="HMAC-SHA256 keyed with the server seed over the public seed. If the full 256-bit digest is divisible by 20 the round crashes instantly at 1.00x; otherwise the first 52 bits set the multiplier. There is no nonce."
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[360px_1fr]">
        <Card>
          <CardContent className="space-y-5">
            <SeedFields value={seeds} onChange={setSeeds} errors={errors} withNonce={false} clientLabel="Public Seed" />
            <div>
              <Label htmlFor="reportedMultiplier">Reported Multiplier (optional)</Label>
              <Input
                id="reportedMultiplier"
                data-testid="reported-multiplier"
                value={reportedText}
                onChange={(e) => setReportedText(e.target.value)}
                placeholder="e.g. 1.25"
                invalid={!!reportedErr}
                aria-invalid={!!reportedErr}
              />
              <FieldError>{reportedErr}</FieldError>
              <p className="mt-1 text-xs text-muted">Compared exactly: the algorithm only produces whole hundredths, so 1.254 is not 1.25.</p>
            </div>
            <VerifyBar onRun={() => !reportedErr && v.run(input)} onSave={() => !reportedErr && v.run(input, true)} busy={v.busy} saved={v.saved} error={v.error} stale={stale} />
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card className="grid-bg overflow-hidden">
            <CardContent className="flex flex-col items-center justify-center py-14">
              <div className="text-xs uppercase tracking-[0.3em] text-muted">Calculated crash point</div>
              <div className={cn("mt-3 font-mono text-7xl font-bold tabular-nums sm:text-8xl", color)} data-testid="crash-multiplier" aria-live="polite">
                {m === undefined ? "—.——" : m.toFixed(2)}
                <span className="text-4xl">x</span>
              </div>
              {v.result?.reported?.multiplier !== undefined && !stale && (
                <div className="mt-3 text-sm text-muted">
                  Reported: <span className="font-mono text-fg">{String(v.result.reported.multiplier)}x</span>
                </div>
              )}
            </CardContent>
          </Card>
          {stale && <StaleNotice />}
          {calc?.instantCrash && (
            <Card className="border-bad/40">
              <CardContent className="flex gap-3">
                <Zap className="mt-0.5 h-5 w-5 shrink-0 text-bad" aria-hidden />
                <div className="text-sm">
                  <div className="font-semibold text-bad">Instant crash</div>
                  <p className="mt-1 text-muted">
                    The whole 256-bit digest, read as one integer, leaves remainder 0 when divided by 20, so the published algorithm returns 1.00x without evaluating the
                    formula. This happens for 1 in 20 seed pairs on average.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
          {calc && (
            <Card>
              <CardHeader>
                <CardTitle>Formula</CardTitle>
                <span className="text-xs text-muted">JavaScript double-precision arithmetic, exactly as published</span>
              </CardHeader>
              <CardContent className="space-y-2 font-mono text-sm">
                <Line k="1. HMAC-SHA256(key = server seed, msg = public seed)" v={calc.digest} />
                <Line k="2. BigInt(digest) mod 20" v={`${calc.mod20}${calc.mod20 === 0 ? "  → instant crash at 1.00x" : "  → not 0, continue"}`} />
                {!calc.instantCrash && calc.h !== null && (
                  <>
                    <Line k="3. h = parseInt(digest[0..13], 16)" v={`0x${calc.digest.slice(0, 13)} = ${calc.h}`} />
                    <Line k="4. e = 2^52" v={String(calc.e)} />
                    <Line k="5. (100·e − h) / (e − h)" v={String((100 * calc.e - calc.h) / (calc.e - calc.h))} />
                    <Line k="6. floor(…) / 100" v={`${calc.multiplierText}x`} />
                  </>
                )}
              </CardContent>
            </Card>
          )}
          {v.result && !stale && <ComparisonTable rows={v.result.comparisons} />}
          {v.result && !stale && <StatusPanel result={v.result} />}
          {v.result && !stale && <TraceView steps={v.result.trace} />}
        </div>
      </div>
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid gap-1 border-b border-line/50 pb-2 sm:grid-cols-[340px_1fr]">
      <span className="font-sans text-muted">{k}</span>
      <span className="break-all">{v}</span>
    </div>
  );
}
