import { useMemo, useState } from "react";
import { Grid3x3, Eraser } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, FieldError, Label, Segmented, Textarea } from "@/components/ui";
import { PageHeader, SeedFields, StatusPanel, TraceView, VerifyBar, emptySeeds, errorMap, seedPayload, type SeedState } from "@/components/verification";
import { useVerifier } from "@/services/useVerifier";
import type { AlgorithmVersion, KenoDifficulty } from "@/services/api";
import { cn, parseIntList } from "@/lib/utils";

const DIFFICULTIES: KenoDifficulty[] = ["CLASSIC", "LOW", "MEDIUM", "HIGH", "EXTREME"];
const BOARD: Record<KenoDifficulty, number> = { CLASSIC: 40, LOW: 40, MEDIUM: 40, HIGH: 40, EXTREME: 56 };
const MAX_PICKS = 10;
const title = (d: string) => d[0] + d.slice(1).toLowerCase();

export function KenoPage() {
  const [seeds, setSeeds] = useState<SeedState>(emptySeeds);
  const [version, setVersion] = useState<AlgorithmVersion>("hmac_sha256_v2");
  const [difficulty, setDifficulty] = useState<KenoDifficulty>("CLASSIC");
  const [picks, setPicks] = useState<number[]>([]);
  const [reportedText, setReportedText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const v = useVerifier();
  const tileCount = BOARD[difficulty];

  const reported = useMemo(() => parseIntList(reportedText), [reportedText]);
  const input = {
    game: "keno",
    ...seedPayload(seeds, true),
    algorithmVersion: version,
    difficulty,
    selectedNumbers: picks,
    reported: reported.values.length ? { draw: reported.values } : null,
  };
  const errors = errorMap(v.result);
  const stale = v.isStale(input);
  const calc = !stale ? v.result?.calculated : null;
  const drawn: number[] = calc?.drawn ?? [];
  const reportedDraw: number[] = (!stale && v.result?.reported?.draw) || [];

  const changeDifficulty = (d: KenoDifficulty) => {
    const max = BOARD[d];
    const outside = picks.filter((n) => n > max);
    if (outside.length) setNotice(`Removed ${outside.length} selection(s) outside 1–${max}: ${outside.join(", ")}`);
    else setNotice(null);
    setPicks(picks.filter((n) => n <= max));
    setDifficulty(d);
  };

  const toggle = (n: number) => {
    setNotice(null);
    setPicks((prev) => {
      if (prev.includes(n)) return prev.filter((p) => p !== n);
      if (prev.length >= MAX_PICKS) {
        setNotice("Maximum of 10 numbers selected — deselect one first.");
        return prev;
      }
      return [...prev, n];
    });
  };

  const run = (save = false) => {
    if (reported.error) return;
    v.run(input, save);
  };

  return (
    <div>
      <PageHeader
        icon={<Grid3x3 className="h-5 w-5" />}
        title="Keno Verification"
        subtitle="Reconstructs the ten winning numbers from the revealed server seed, client seed and nonce. Your picks and the risk level are not part of the draw — only Extreme changes the board to 56 numbers."
      />
      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        {/* Configuration panel */}
        <Card>
          <CardContent className="space-y-5">
            <div>
              <Label>Algorithm</Label>
              <Segmented
                testId="keno-version"
                value={version}
                onChange={setVersion}
                options={[
                  { value: "hmac_sha256_v2", label: "HMAC SHA256 V2" },
                  { value: "seedrandom_v1", label: "Seedrandom V1" },
                ]}
              />
            </div>
            <div>
              <Label>Difficulty / Risk</Label>
              <Segmented testId="keno-difficulty" value={difficulty} onChange={changeDifficulty} options={DIFFICULTIES.map((d) => ({ value: d, label: title(d) }))} />
              <p className="mt-1.5 text-xs text-muted">
                <span className="font-semibold text-accent-2">{title(difficulty)}</span>: {tileCount} numbers, 10 drawn.
              </p>
            </div>
            <SeedFields value={seeds} onChange={setSeeds} errors={errors} withNonce />
            <div>
              <Label htmlFor="reportedDraw">Reported Draw (optional)</Label>
              <Textarea
                id="reportedDraw"
                data-testid="reported-draw"
                rows={2}
                value={reportedText}
                onChange={(e) => setReportedText(e.target.value)}
                placeholder="e.g. 27 35 20 8 1 29 37 2 19 10"
                invalid={!!reported.error}
              />
              <FieldError>{reported.error}</FieldError>
            </div>
            <VerifyBar onRun={() => run(false)} onSave={() => run(true)} busy={v.busy} saved={v.saved} error={v.error} />
          </CardContent>
        </Card>

        <div className="space-y-6">
          {/* Board */}
          <Card className="grid-bg">
            <CardContent>
              <div className="mx-auto grid max-w-3xl grid-cols-8 gap-2 sm:gap-2.5" data-testid="keno-board" data-tiles={tileCount}>
                {Array.from({ length: tileCount }, (_, i) => i + 1).map((n) => {
                  const picked = picks.includes(n);
                  const win = drawn.includes(n);
                  const reportedOnly = reportedDraw.includes(n) && !win && drawn.length > 0;
                  const state = picked && win ? "match" : win ? "win" : picked ? "picked" : "idle";
                  return (
                    <button
                      key={n}
                      type="button"
                      data-testid={`keno-tile-${n}`}
                      data-state={state}
                      data-reported-only={reportedOnly ? "true" : undefined}
                      onClick={() => toggle(n)}
                      className={cn(
                        "tile relative aspect-[1.15] cursor-pointer rounded-xl text-base font-bold sm:text-lg",
                        state === "idle" && "text-fg/90",
                      )}
                    >
                      {n}
                      {state === "match" && <span className="absolute right-1 top-0.5 text-[10px]">★</span>}
                    </button>
                  );
                })}
              </div>
              <div className="mx-auto mt-5 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel-2/80 px-4 py-3">
                <div>
                  <div className="text-sm font-medium" data-testid="pick-counter">
                    Selected Numbers: {picks.length} / {MAX_PICKS}
                  </div>
                  <div className="text-xs text-muted">{picks.length === 0 ? "Select 1–10 numbers" : `Picks: ${[...picks].sort((a, b) => a - b).join(", ")}`}</div>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted">
                  <Legend className="bg-accent" label="Selected" />
                  <Legend className="bg-[#1e3a3a] ring-2 ring-ok/60" label="Winning" />
                  <Legend className="bg-ok" label="Match" />
                  <Button variant="secondary" size="sm" onClick={() => (setPicks([]), setNotice(null))} data-testid="clear-selection">
                    <Eraser className="h-3.5 w-3.5" /> Clear Selection
                  </Button>
                </div>
              </div>
              {(notice || errors.selectedNumbers) && <p className="mx-auto mt-2 max-w-3xl text-xs text-warn">{notice ?? errors.selectedNumbers}</p>}
              {picks.length === 0 && v.result && !stale && (
                <p className="mx-auto mt-2 max-w-3xl text-xs text-muted">No picks selected — the draw is still verified; select 1–10 numbers to count matches.</p>
              )}
            </CardContent>
          </Card>

          {stale && <p className="rounded-lg border border-warn/30 bg-warn/5 px-4 py-2 text-sm text-warn">Inputs changed since the last calculation — run Calculate / Verify again.</p>}

          {calc && (
            <Card>
              <CardHeader>
                <CardTitle>Draw result</CardTitle>
                <span className="text-xs text-muted">{title(calc.difficulty)} · {calc.tileCount} tiles · {v.result?.algorithmVersion}</span>
              </CardHeader>
              <CardContent className="grid gap-6 md:grid-cols-[180px_1fr]">
                <div className="rounded-2xl bg-panel-2 p-4 text-center">
                  <div className="text-5xl font-bold text-ok" data-testid="match-count">{calc.matchCount}</div>
                  <div className="mt-1 text-xs uppercase tracking-wider text-muted">matches of {calc.pickCount} picks</div>
                </div>
                <div className="space-y-3">
                  <Sequence label="Calculated draw (generation order)" values={drawn} highlight={calc.matched} testId="calculated-draw" />
                  {reportedDraw.length > 0 && <Sequence label="Reported draw" values={reportedDraw} bad={reportedDraw.filter((n) => !drawn.includes(n))} />}
                  <Sequence label="Matched numbers" values={calc.matched} highlight={calc.matched} />
                </div>
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

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("inline-block h-3 w-3 rounded", className)} />
      {label}
    </span>
  );
}

export function Sequence({ label, values, highlight = [], bad = [], testId }: { label: string; values: number[]; highlight?: number[]; bad?: number[]; testId?: string }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className="flex flex-wrap gap-1.5" data-testid={testId}>
        {values.length === 0 && <span className="text-sm text-muted">—</span>}
        {values.map((n, i) => (
          <span
            key={i}
            className={cn(
              "min-w-9 rounded-lg border px-2 py-1 text-center font-mono text-sm",
              highlight.includes(n) ? "border-ok/50 bg-ok/15 text-ok" : bad.includes(n) ? "border-bad/50 bg-bad/15 text-bad" : "border-line bg-panel-2",
            )}
          >
            {n}
          </span>
        ))}
      </div>
    </div>
  );
}
