import { useMemo, useReducer, useState } from "react";
import { Grid3x3, Eraser } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, FieldError, Label, Segmented, Textarea } from "@/components/ui";
import { ComparisonTable, PageHeader, SeedFields, StaleNotice, StatusPanel, TraceView, VerifyBar, emptySeeds, errorMap, seedPayload, type SeedState } from "@/components/verification";
import { useVerifier } from "@/services/useVerifier";
import { KENO_BOARD, KENO_DIFFICULTIES, KENO_MAX_PICKS, type AlgorithmVersion, type KenoDifficulty } from "@/services/api";
import { cn, parseIntList } from "@/lib/utils";

const title = (d: string) => d[0] + d.slice(1).toLowerCase();

interface PickState {
  picks: number[];
  notice: string | null;
}
type PickAction = { type: "toggle"; n: number } | { type: "clear" } | { type: "board"; max: number };

/** Pure reducer: rapid clicks can never race, and the 10-pick cap is enforced in one place. */
export function pickReducer(s: PickState, a: PickAction): PickState {
  switch (a.type) {
    case "toggle":
      if (s.picks.includes(a.n)) return { picks: s.picks.filter((p) => p !== a.n), notice: null };
      if (s.picks.length >= KENO_MAX_PICKS) return { ...s, notice: "Maximum of 10 numbers selected — deselect one first." };
      return { picks: [...s.picks, a.n], notice: null };
    case "clear":
      return { picks: [], notice: null };
    case "board": {
      const outside = s.picks.filter((n) => n > a.max);
      return outside.length ? { picks: s.picks.filter((n) => n <= a.max), notice: `Removed ${outside.length} selection(s) outside 1–${a.max}: ${outside.join(", ")}` } : { ...s, notice: null };
    }
  }
}

export function KenoPage() {
  const [seeds, setSeeds] = useState<SeedState>(emptySeeds);
  const [version, setVersion] = useState<AlgorithmVersion>("hmac_sha256_v2");
  const [difficulty, setDifficulty] = useState<KenoDifficulty>("CLASSIC");
  const [{ picks, notice }, dispatch] = useReducer(pickReducer, { picks: [], notice: null });
  const [reportedText, setReportedText] = useState("");
  const v = useVerifier<"keno">();
  const tileCount = KENO_BOARD[difficulty].tileCount;

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
  const drawn = calc?.drawn ?? [];
  const reportedDraw = (!stale && (v.result?.reported?.draw as number[] | undefined)) || [];

  const changeDifficulty = (d: KenoDifficulty) => {
    dispatch({ type: "board", max: KENO_BOARD[d].tileCount });
    setDifficulty(d);
  };
  const run = (save = false) => {
    if (!reported.error) v.run(input, save);
  };

  return (
    <div>
      <PageHeader
        icon={<Grid3x3 className="h-5 w-5" />}
        title="Keno Verification"
        subtitle="Reconstructs the ten winning numbers from the revealed server seed, client seed and nonce. Your picks and the risk level are not part of the draw — only Extreme changes the board to 56 numbers."
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[360px_1fr]">
        <Card>
          <CardContent className="space-y-5">
            <div>
              <Label id="keno-version-label">Algorithm</Label>
              <Segmented
                testId="keno-version"
                ariaLabel="Algorithm version"
                value={version}
                onChange={setVersion}
                options={[
                  { value: "hmac_sha256_v2", label: "HMAC SHA256 V2" },
                  { value: "seedrandom_v1", label: "Seedrandom V1" },
                ]}
              />
              <p className="mt-1.5 text-xs text-muted">Use the version shown for the round in Solpump — never pick the one that happens to match.</p>
            </div>
            <div>
              <Label>Difficulty / Risk</Label>
              <Segmented testId="keno-difficulty" ariaLabel="Difficulty" value={difficulty} onChange={changeDifficulty} options={KENO_DIFFICULTIES.map((d) => ({ value: d, label: title(d) }))} />
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
                aria-invalid={!!reported.error}
              />
              <FieldError>{reported.error}</FieldError>
            </div>
            <VerifyBar onRun={() => run(false)} onSave={() => run(true)} busy={v.busy} saved={v.saved} error={v.error} stale={stale} />
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="grid-bg">
            <CardContent>
              <div className="mx-auto grid max-w-3xl grid-cols-8 gap-2 sm:gap-2.5" role="group" aria-label={`Keno board, ${tileCount} numbers`} data-testid="keno-board" data-tiles={tileCount}>
                {Array.from({ length: tileCount }, (_, i) => i + 1).map((n) => {
                  const picked = picks.includes(n);
                  const order = drawn.indexOf(n);
                  const win = order >= 0;
                  const reportedOnly = reportedDraw.includes(n) && !win && drawn.length > 0;
                  const state = picked && win ? "match" : win ? "win" : picked ? "picked" : "idle";
                  const desc = [picked && "selected", win && `winning number, drawn ${order + 1}${order === 0 ? "st" : order === 1 ? "nd" : order === 2 ? "rd" : "th"}`, reportedOnly && "reported but not drawn"].filter(Boolean).join(", ");
                  return (
                    <button
                      key={n}
                      type="button"
                      data-testid={`keno-tile-${n}`}
                      data-state={state}
                      data-reported-only={reportedOnly ? "true" : undefined}
                      aria-pressed={picked}
                      aria-label={`Number ${n}${desc ? `, ${desc}` : ""}`}
                      onClick={() => dispatch({ type: "toggle", n })}
                      className={cn("tile relative aspect-[1.15] cursor-pointer rounded-xl text-base font-bold sm:text-lg", state === "idle" && "text-fg/90")}
                    >
                      {n}
                      {win && <span className="absolute right-1 top-0.5 text-[10px] font-semibold opacity-80" aria-hidden>#{order + 1}</span>}
                    </button>
                  );
                })}
              </div>
              <div className="mx-auto mt-5 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel-2/80 px-4 py-3">
                <div aria-live="polite">
                  <div className="text-sm font-medium" data-testid="pick-counter">
                    Selected Numbers: {picks.length} / {KENO_MAX_PICKS}
                  </div>
                  <div className="text-xs text-muted">{picks.length === 0 ? "Select 1–10 numbers" : `Picks: ${[...picks].sort((a, b) => a - b).join(", ")}`}</div>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                  <Legend state="picked" label="Selected" />
                  <Legend state="win" label="Winning (#draw order)" />
                  <Legend state="match" label="Match" />
                  <Button variant="secondary" size="sm" onClick={() => dispatch({ type: "clear" })} data-testid="clear-selection">
                    <Eraser className="h-3.5 w-3.5" aria-hidden /> Clear Selection
                  </Button>
                </div>
              </div>
              {(notice || errors.selectedNumbers) && (
                <p className="mx-auto mt-2 max-w-3xl text-xs text-warn" role="status">
                  {notice ?? errors.selectedNumbers}
                </p>
              )}
              {picks.length === 0 && v.result && !stale && <p className="mx-auto mt-2 max-w-3xl text-xs text-muted">No picks selected — the draw is still verified; select 1–10 numbers to count matches.</p>}
            </CardContent>
          </Card>

          {stale && <StaleNotice />}

          {calc && (
            <Card>
              <CardHeader>
                <CardTitle>Draw result</CardTitle>
                <span className="text-xs text-muted">
                  {title(calc.difficulty)} · {calc.tileCount} tiles · {v.result?.algorithmVersion}
                </span>
              </CardHeader>
              <CardContent className="grid gap-6 md:grid-cols-[180px_1fr]">
                <div className="rounded-2xl bg-panel-2 p-4 text-center">
                  <div className="text-5xl font-bold text-ok" data-testid="match-count">
                    {calc.matchCount}
                  </div>
                  <div className="mt-1 text-xs uppercase tracking-wider text-muted">matches of {calc.pickCount} picks</div>
                </div>
                <div className="space-y-3">
                  <Sequence label="Calculated draw (generation order)" values={drawn} highlight={calc.matched} testId="calculated-draw" numbered />
                  <Sequence label="Raw indices into the shrinking list" values={calc.indices} />
                  {reportedDraw.length > 0 && <Sequence label="Reported draw" values={reportedDraw} bad={reportedDraw.filter((n) => !drawn.includes(n))} />}
                  <Sequence label="Matched numbers" values={calc.matched} highlight={calc.matched} />
                </div>
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

function Legend({ state, label }: { state: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="tile inline-block h-3.5 w-3.5 rounded" data-state={state} aria-hidden />
      {label}
    </span>
  );
}

export function Sequence({ label, values, highlight = [], bad = [], testId, numbered }: { label: string; values: number[]; highlight?: number[]; bad?: number[]; testId?: string; numbered?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wider text-muted">{label}</div>
      <ol className="flex flex-wrap gap-1.5" data-testid={testId}>
        {values.length === 0 && <li className="text-sm text-muted">—</li>}
        {values.map((n, i) => (
          <li
            key={i}
            title={numbered ? `draw ${i + 1}` : undefined}
            className={cn(
              "min-w-9 rounded-lg border px-2 py-1 text-center font-mono text-sm",
              highlight.includes(n) ? "border-ok/50 bg-ok/15 text-ok" : bad.includes(n) ? "border-bad/50 bg-bad/15 text-bad" : "border-line bg-panel-2",
            )}
          >
            {n}
          </li>
        ))}
      </ol>
    </div>
  );
}
