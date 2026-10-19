import { useMemo, useState } from "react";
import { Bomb, Gem, Minus, Plus, MousePointerClick } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, FieldError, Input, Label, Segmented, Select, Textarea } from "@/components/ui";
import { ComparisonTable, PageHeader, SeedFields, StaleNotice, StatusPanel, TraceView, VerifyBar, emptySeeds, errorMap, seedPayload, type SeedState } from "@/components/verification";
import { useVerifier } from "@/services/useVerifier";
import { MINES_GRID_SIZES, type AlgorithmVersion } from "@/services/api";
import { cn, parseIntList } from "@/lib/utils";

const GRIDS = MINES_GRID_SIZES;
type Grid = (typeof GRIDS)[number];
const PRESETS = [1, 3, 5, 10];
type View = "all" | "mines" | "safe" | "clicked" | "diff";

export function MinesPage() {
  const [seeds, setSeeds] = useState<SeedState>(emptySeeds);
  const [version, setVersion] = useState<AlgorithmVersion>("hmac_sha256_v2");
  const [grid, setGrid] = useState<Grid>(5);
  const [mineCount, setMineCount] = useState(3);
  const [mineText, setMineText] = useState("3");
  const [indexBase, setIndexBase] = useState<0 | 1>(0);
  const [reportedText, setReportedText] = useState("");
  const [clicked, setClicked] = useState<number[]>([]); // always 0-based internally
  const [reportedOutcome, setReportedOutcome] = useState<"" | "win" | "loss">("");
  const [view, setView] = useState<View>("all");
  const v = useVerifier<"mines">();

  const tileCount = grid * grid;
  const maxMines = tileCount - 1;
  const mineError = !/^\d+$/.test(mineText) || mineCount < 1 || mineCount > maxMines ? `Mines must be 1–${maxMines} on a ${grid}×${grid} grid` : null;

  const setMines = (n: number) => {
    const c = Math.max(1, Math.min(maxMines, n));
    setMineCount(c);
    setMineText(String(c));
  };
  const changeGrid = (g: Grid) => {
    setGrid(g);
    const max = g * g - 1;
    if (mineCount > max) setMines(max);
    setClicked(clicked.filter((t) => t < g * g));
  };

  const reported = useMemo(() => parseIntList(reportedText), [reportedText]);
  const input = {
    game: "mines",
    ...seedPayload(seeds, true),
    algorithmVersion: version,
    gridSize: grid,
    mineCount,
    // Evidence is sent exactly as entered: positions in the chosen base, clicked tiles converted to the
    // same base, so the stored record preserves the original numbering (provenance).
    indexBase,
    clickedTiles: clicked.map((t) => t + indexBase),
    reported: reported.values.length || reportedOutcome ? { mines: reported.values.length ? reported.values : null, outcome: reportedOutcome || null } : null,
  };
  const errors = errorMap(v.result);
  const stale = v.isStale(input);
  const calc = !stale ? v.result?.calculated : null;
  const mines: number[] = calc?.mines ?? [];
  // the verifier reports positions back in 0-based form
  const repMines: number[] = ((!stale && (v.result?.reported?.mines as number[] | undefined)) || []);

  const toggleClick = (t: number) => setClicked((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  return (
    <div>
      <PageHeader
        icon={<Bomb className="h-5 w-5" />}
        title="Mines Verification"
        subtitle="Reconstructs mine placement from serverSeed:clientSeed:nonce. Difficulty is just the grid size plus mine count. Click tiles to mark the ones you originally revealed."
      />
      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <Card>
          <CardContent className="space-y-5">
            <div>
              <Label>Algorithm</Label>
              <Segmented
                ariaLabel="Algorithm version"
                testId="mines-version"
                value={version}
                onChange={setVersion}
                options={[
                  { value: "hmac_sha256_v2", label: "HMAC SHA256 V2" },
                  { value: "seedrandom_v1", label: "Seedrandom V1" },
                ]}
              />
            </div>
            <div>
              <Label>Grid</Label>
              <Segmented testId="mines-grid" ariaLabel="Grid size in tiles" value={grid} onChange={changeGrid} options={GRIDS.map((g) => ({ value: g, label: String(g * g) }))} />
              <p className="mt-1.5 text-xs text-muted">
                {grid}×{grid} · {tileCount} tiles · 1–{maxMines} mines
              </p>
            </div>
            <div>
              <Label htmlFor="mineCount">Number of Mines</Label>
              <div className="flex gap-2">
                <Button variant="secondary" size="icon" onClick={() => setMines(mineCount - 1)} disabled={mineCount <= 1} aria-label="Decrease mines" data-testid="mines-dec">
                  <Minus className="h-4 w-4" />
                </Button>
                <Input
                  id="mineCount"
                  data-testid="mine-count"
                  className="text-center"
                  inputMode="numeric"
                  value={mineText}
                  invalid={!!mineError}
                  onChange={(e) => {
                    setMineText(e.target.value);
                    const n = Number(e.target.value);
                    if (/^\d+$/.test(e.target.value)) setMineCount(n);
                  }}
                  onBlur={() => /^\d+$/.test(mineText) && setMines(Number(mineText))}
                />
                <Button variant="secondary" size="icon" onClick={() => setMines(mineCount + 1)} disabled={mineCount >= maxMines} aria-label="Increase mines" data-testid="mines-inc">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <FieldError>{mineError ?? errors.mineCount}</FieldError>
              <div className="mt-2 flex gap-1.5">
                {PRESETS.map((p) => (
                  <Button key={p} variant={mineCount === p ? "default" : "secondary"} size="sm" className="flex-1" disabled={p > maxMines} onClick={() => setMines(p)} data-testid={`preset-${p}`}>
                    {p}
                  </Button>
                ))}
              </div>
            </div>
            <SeedFields value={seeds} onChange={setSeeds} errors={errors} withNonce />
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <Label htmlFor="reportedMines" className="mb-0">Reported Positions (optional)</Label>
                <Select className="h-7 w-auto text-xs" aria-label="Numbering of reported positions and clicked tiles" value={indexBase} onChange={(e) => setIndexBase(Number(e.target.value) as 0 | 1)} data-testid="index-base">
                  <option value={0}>0-based</option>
                  <option value={1}>1-based</option>
                </Select>
              </div>
              <Textarea id="reportedMines" data-testid="reported-mines" rows={2} value={reportedText} onChange={(e) => setReportedText(e.target.value)} placeholder={indexBase ? "e.g. 1 15 23" : "e.g. 0 14 22"} invalid={!!reported.error} />
              <FieldError>{reported.error ?? errors["reported.mines"] ?? errors.reported}</FieldError>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="mines-outcome">Original outcome</Label>
                <Select id="mines-outcome" value={reportedOutcome} onChange={(e) => setReportedOutcome(e.target.value as "" | "win" | "loss")}>
                  <option value="">Not supplied</option>
                  <option value="win">Win (cashed out)</option>
                  <option value="loss">Loss (hit a mine)</option>
                </Select>
              </div>
              <div>
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">Clicked tiles</span>
                <div className="flex h-9 items-center justify-between rounded-lg border border-line bg-bg px-3 text-sm">
                  <span>{clicked.length}</span>
                  {clicked.length > 0 && (
                    <button className="cursor-pointer text-xs text-muted hover:text-fg" onClick={() => setClicked([])}>
                      clear
                    </button>
                  )}
                </div>
              </div>
            </div>
            <VerifyBar onRun={() => !reported.error && !mineError && v.run(input)} onSave={() => !reported.error && !mineError && v.run(input, true)} busy={v.busy} saved={v.saved} error={v.error} />
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="grid-bg">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MousePointerClick className="h-4 w-4 text-accent-2" /> Board · {grid}×{grid}
              </CardTitle>
              <Segmented
                className="max-w-xl text-xs"
                ariaLabel="Board view"
                testId="mines-view"
                value={view}
                onChange={setView}
                options={[
                  { value: "all", label: "All tiles" },
                  { value: "mines", label: "Mines" },
                  { value: "safe", label: "Safe" },
                  { value: "clicked", label: "Clicked" },
                  { value: "diff", label: "Differences" },
                ]}
              />
            </CardHeader>
            <CardContent>
              <div
                className="mx-auto grid gap-2"
                style={{ gridTemplateColumns: `repeat(${grid}, minmax(0, 1fr))`, maxWidth: Math.min(640, grid * 88) }}
                role="group"
                aria-label={`Mines board ${grid} by ${grid}; click a tile to mark it as originally revealed`}
                data-testid="mines-board"
                data-tiles={tileCount}
              >
                {Array.from({ length: tileCount }, (_, t) => {
                  const isMine = mines.includes(t);
                  const isClicked = clicked.includes(t);
                  const isRep = repMines.includes(t);
                  const diff = calc && repMines.length > 0 && isMine !== isRep;
                  const known = !!calc;
                  const showMine = known && isMine && (view === "all" || view === "mines" || (view === "clicked" && isClicked) || (view === "diff" && diff));
                  const showSafe = known && !isMine && (view === "all" || view === "safe" || (view === "clicked" && isClicked));
                  const dim =
                    known &&
                    ((view === "mines" && !isMine) || (view === "safe" && isMine) || (view === "clicked" && !isClicked) || (view === "diff" && !diff));
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleClick(t)}
                      data-testid={`mine-tile-${t}`}
                      data-mine={known ? String(isMine) : undefined}
                      data-reveal={showMine ? "mine" : showSafe ? "safe" : undefined}
                      data-diff={diff ? "true" : undefined}
                      title={`Tile ${t + 1} (index ${t}) · row ${Math.floor(t / grid) + 1}, col ${(t % grid) + 1}`}
                      aria-pressed={isClicked}
                      aria-label={`Tile ${t + 1}, index ${t}, row ${Math.floor(t / grid) + 1}, column ${(t % grid) + 1}${known ? (isMine ? ", mine" : ", safe") : ""}${isClicked ? ", marked as clicked" : ""}${diff ? ", differs from report" : ""}`}
                      className={cn(
                        "tile relative flex aspect-square cursor-pointer flex-col items-center justify-center rounded-xl",
                        isClicked && "outline-2 outline-offset-2 outline-accent-2",
                        dim && "opacity-25",
                      )}
                    >
                      {showMine ? <Bomb className="h-1/3 w-1/3 text-bad" /> : showSafe ? <Gem className="h-1/3 w-1/3 text-ok" /> : null}
                      <span className="absolute left-1.5 top-1 text-[10px] font-semibold text-muted">{t + 1}</span>
                      <span className="absolute bottom-1 right-1.5 font-mono text-[9px] text-muted/70">#{t}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-4 text-center text-xs text-muted">
                Top-left label = 1-based tile number · bottom-right <span className="font-mono">#n</span> = 0-based index used by the algorithm (row-major, left→right, top→bottom).
              </p>
            </CardContent>
          </Card>

          {stale && <StaleNotice />}

          {calc && (
            <Card>
              <CardHeader>
                <CardTitle>Placement result</CardTitle>
                <span className="text-xs text-muted">{calc.mineCount} mines · {calc.tileCount - calc.mineCount} safe</span>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Row label="Mines in generation order (0-based)" value={calc.mines.join(", ")} testId="calculated-mines" />
                <Row label="Mines sorted (0-based)" value={calc.minesSorted.join(", ")} />
                <Row label="Mines sorted (1-based tiles)" value={calc.minesSorted.map((n: number) => n + 1).join(", ")} />
                <Row label="Safe tiles (0-based)" value={calc.safe.join(", ")} />
                <Row label="Raw indices into the shrinking list" value={calc.indices.join(", ")} />
                {repMines.length > 0 && <Row label="Reported (converted to 0-based)" value={repMines.join(", ")} />}
                {calc.clickedTiles.length > 0 && (
                  <Row label="Clicked tiles → derived outcome" value={`${calc.clickedTiles.join(", ")} → ${calc.derivedOutcome}${calc.clickedMines.length ? ` (mine at ${calc.clickedMines.join(", ")})` : ""}`} />
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

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[260px_1fr]">
      <span className="text-muted">{label}</span>
      <span className="font-mono break-all" data-testid={testId}>{value || "—"}</span>
    </div>
  );
}
