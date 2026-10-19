import { useEffect, useState } from "react";
import { Binary, DatabaseBackup, Download, GitCompare, Plus, Settings as SettingsIcon, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Segmented, Select } from "@/components/ui";
import { PageHeader, StatusBadge } from "@/components/verification";
import { api, KENO_DIFFICULTIES, MINES_GRID_SIZES, type KenoDifficulty, type Settings, type VerificationResult } from "@/services/api";
import type { KenoCalculated, MinesCalculated } from "@shared/contracts";

/* ---------------- Cryptographic (HMAC) inspector ---------------- */
type Part = { value: string; encoding: "utf8" | "hex" | "uint32be" };
const V2_LABEL = "solpump:provably-fair:hmac-sha256:v2";

export function HmacInspectorPage() {
  const [key, setKey] = useState("");
  const [keyEnc, setKeyEnc] = useState<"utf8" | "hex">("utf8");
  const [parts, setParts] = useState<Part[]>([{ value: "", encoding: "utf8" }]);
  const [out, setOut] = useState<Awaited<ReturnType<typeof api.hmac>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [explain, setExplain] = useState<string | null>(null);
  const [p, setP] = useState({ server: "", client: "", nonce: "1", n: "0" });

  const run = async (k = key, ke = keyEnc, ps = parts) => {
    setErr(null);
    try {
      setOut(await api.hmac({ key: k, keyEncoding: ke, parts: ps }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const load = async (k: string, ps: Part[], text: string) => {
    setKey(k);
    setKeyEnc("utf8");
    setParts(ps);
    setExplain(text);
    await run(k, "utf8", ps);
  };
  const preset = async (kind: "crash" | "blackjack" | "keno" | "mines") => {
    const n = p.n || "0";
    if (kind === "crash") return load(p.server, [{ value: p.client, encoding: "utf8" }], "Crash: key = server seed, message = public seed. Digest mod 20 == 0 → 1.00x; else the first 13 hex chars give h.");
    if (kind === "blackjack") return load(p.server, [{ value: p.client, encoding: "utf8" }, { value: n, encoding: "utf8" }], `Blackjack card ${n}: key = server seed, message = client seed immediately followed by "${n}". Rank = h mod 13, suit = h mod 4 (h = first 13 hex chars).`);
    const tr = await api.transcript(kind === "keno" ? [V2_LABEL, "keno", p.client, p.nonce] : [V2_LABEL, "mines", "", "0"]);
    const k = kind === "keno" ? p.server : `${p.server}:${p.client}:${p.nonce}`;
    return load(
      k,
      [{ value: tr.hex, encoding: "hex" }, { value: n, encoding: "uint32be" }],
      `${kind === "keno" ? "Keno" : "Mines"} v2 block ${n}: key = ${kind === "keno" ? "server seed" : "serverSeed:clientSeed:nonce"}, message = length-prefixed transcript || uint32be(${n}). The 32-byte result is read as 8 big-endian uint32 values; each draw rejects values ≥ 2^32 − (2^32 mod remaining) and uses value mod remaining.`,
    );
  };
  const words = out ? Array.from({ length: 8 }, (_, i) => parseInt(out.hmac.slice(i * 8, i * 8 + 8), 16)) : [];

  return (
    <div>
      <PageHeader icon={<Binary className="h-5 w-5" />} title="HMAC Inspector" subtitle="Recompute any single HMAC step of any game by hand. Presets reproduce exactly what the verifiers do; nothing here changes how results are calculated." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Presets from seeds</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><Label htmlFor="ps">Server seed</Label><Input id="ps" value={p.server} onChange={(e) => setP({ ...p, server: e.target.value })} /></div>
              <div><Label htmlFor="pc">Client / public seed</Label><Input id="pc" value={p.client} onChange={(e) => setP({ ...p, client: e.target.value })} /></div>
              <div><Label htmlFor="pn">Nonce</Label><Input id="pn" value={p.nonce} onChange={(e) => setP({ ...p, nonce: e.target.value })} /></div>
              <div><Label htmlFor="pk">Card number / block counter</Label><Input id="pk" value={p.n} onChange={(e) => setP({ ...p, n: e.target.value })} /></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => preset("crash")}>Crash digest</Button>
              <Button size="sm" variant="secondary" onClick={() => preset("blackjack")}>Blackjack card</Button>
              <Button size="sm" variant="secondary" onClick={() => preset("keno")}>Keno v2 block</Button>
              <Button size="sm" variant="secondary" onClick={() => preset("mines")}>Mines v2 block</Button>
            </div>
            {explain && <p className="rounded-lg bg-panel-2 p-3 text-xs text-muted">{explain}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>HMAC-SHA256</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="hkey">Key</Label>
              <div className="flex gap-2">
                <Input id="hkey" value={key} onChange={(e) => setKey(e.target.value)} data-testid="hmac-key" />
                <Select className="w-28" aria-label="Key encoding" value={keyEnc} onChange={(e) => setKeyEnc(e.target.value as "utf8" | "hex")}>
                  <option value="utf8">UTF-8</option>
                  <option value="hex">hex</option>
                </Select>
              </div>
            </div>
            <fieldset className="space-y-2">
              <legend className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted">Message parts (concatenated, no separators)</legend>
              {parts.map((pt, i) => (
                <div key={i} className="flex gap-2">
                  <Input aria-label={`Part ${i + 1}`} value={pt.value} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} data-testid={`hmac-part-${i}`} />
                  <Select className="w-32" aria-label={`Part ${i + 1} encoding`} value={pt.encoding} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, encoding: e.target.value as Part["encoding"] } : x)))}>
                    <option value="utf8">UTF-8</option>
                    <option value="hex">hex</option>
                    <option value="uint32be">uint32 BE</option>
                  </Select>
                  <Button variant="ghost" size="icon" onClick={() => setParts(parts.filter((_, j) => j !== i))} disabled={parts.length === 1} aria-label={`Remove part ${i + 1}`}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                </div>
              ))}
              <Button variant="secondary" size="sm" onClick={() => setParts([...parts, { value: "", encoding: "utf8" }])} disabled={parts.length >= 32}><Plus className="h-3.5 w-3.5" aria-hidden /> Add part</Button>
            </fieldset>
            <Button onClick={() => run()} data-testid="hmac-run">Compute</Button>
            {err && <p className="text-sm text-bad" role="alert">{err}</p>}
            {out && (
              <div className="space-y-2 rounded-lg bg-bg p-3 font-mono text-xs">
                <div><span className="font-sans text-muted">Key bytes: </span><span className="break-all">{out.keyHex}</span></div>
                <div><span className="font-sans text-muted">Message bytes: </span><span className="break-all">{out.messageHex}</span></div>
                <div className="text-sm text-accent-2" data-testid="hmac-output"><span className="font-sans text-xs text-muted">HMAC: </span><span className="break-all">{out.hmac}</span></div>
                <div><span className="font-sans text-muted">First 13 hex chars as integer (Crash/Blackjack h): </span>{parseInt(out.hmac.slice(0, 13), 16)}</div>
                <div><span className="font-sans text-muted">As 8 × uint32 big-endian (v2 generator): </span>{words.join(", ")}</div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Algorithm comparison (exploratory) ---------------- */
export function AlgorithmComparisonPage() {
  const [game, setGame] = useState<"keno" | "mines">("keno");
  const [serverSeed, setServerSeed] = useState("");
  const [clientSeed, setClientSeed] = useState("");
  const [nonce, setNonce] = useState("");
  const [difficulty, setDifficulty] = useState<KenoDifficulty>("CLASSIC");
  const [grid, setGrid] = useState(5);
  const [mines, setMines] = useState(3);
  const [res, setRes] = useState<VerificationResult[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setErr(null);
    const input = game === "keno" ? { game, serverSeed, clientSeed, nonce, difficulty } : { game, serverSeed, clientSeed, nonce, gridSize: grid, mineCount: mines };
    try {
      setRes((await api.compareVersions(input)).results);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const summary = (r: VerificationResult) => {
    if (!r.calculated) return r.outcome.details.join("; ");
    return game === "keno" ? (r.calculated as KenoCalculated).drawn.join(", ") : `mines: ${(r.calculated as MinesCalculated).mines.join(", ")}`;
  };

  return (
    <div>
      <PageHeader
        icon={<GitCompare className="h-5 w-5" />}
        title="Algorithm Comparison"
        subtitle="Runs HMAC SHA256 V2 and Seedrandom V1 side by side on the same inputs for forensic inspection."
      />
      <p className="mb-4 rounded-lg border border-warn/40 bg-warn/5 p-3 text-sm text-warn" role="note">
        <b>Exploratory only.</b> Which version applies to a round must come from that round's record. Finding that one version “matches” is not proof — with two candidates, a coincidental match is always possible to look for.
      </p>
      <Card className="mb-6">
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div>
            <Label>Game</Label>
            <Segmented ariaLabel="Game" value={game} onChange={setGame} options={[{ value: "keno", label: "Keno" }, { value: "mines", label: "Mines" }]} />
          </div>
          <div><Label htmlFor="ac-s">Server seed</Label><Input id="ac-s" value={serverSeed} onChange={(e) => setServerSeed(e.target.value)} /></div>
          <div><Label htmlFor="ac-c">Client seed</Label><Input id="ac-c" value={clientSeed} onChange={(e) => setClientSeed(e.target.value)} /></div>
          <div><Label htmlFor="ac-n">Nonce</Label><Input id="ac-n" value={nonce} onChange={(e) => setNonce(e.target.value)} /></div>
          {game === "keno" ? (
            <div>
              <Label htmlFor="ac-d">Difficulty</Label>
              <Select id="ac-d" value={difficulty} onChange={(e) => setDifficulty(e.target.value as KenoDifficulty)}>
                {KENO_DIFFICULTIES.map((d) => <option key={d}>{d}</option>)}
              </Select>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="ac-g">Grid</Label>
                <Select id="ac-g" value={grid} onChange={(e) => (setGrid(Number(e.target.value)), setMines(Math.min(mines, Number(e.target.value) ** 2 - 1)))}>
                  {MINES_GRID_SIZES.map((g) => <option key={g} value={g}>{g}×{g}</option>)}
                </Select>
              </div>
              <div><Label htmlFor="ac-m">Mines</Label><Input id="ac-m" type="number" min={1} max={grid * grid - 1} value={mines} onChange={(e) => setMines(Number(e.target.value))} /></div>
            </div>
          )}
          <div className="flex items-end"><Button className="w-full" onClick={run}>Compare</Button></div>
        </CardContent>
      </Card>
      {err && <p className="mb-4 text-sm text-bad" role="alert">{err}</p>}
      {res && (
        <div className="grid gap-6 md:grid-cols-2">
          {res.map((r) => (
            <Card key={r.algorithmVersion}>
              <CardHeader>
                <CardTitle className="font-mono">{r.algorithmVersion}</CardTitle>
                <div className="flex gap-1"><Badge tone="warn">Exploratory</Badge><StatusBadge status={r.outcome.status} /></div>
              </CardHeader>
              <CardContent className="font-mono text-sm">{summary(r)}</CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Exports ---------------- */
export function ExportPage() {
  const [game, setGame] = useState("");
  const [status, setStatus] = useState("");
  const params = { game, status };
  return (
    <div>
      <PageHeader icon={<Download className="h-5 w-5" />} title="Export Reports" subtitle="Reports separate recorded evidence (what was supplied) from calculated results, include the five evidence sections, provenance, limitations and the full trace, so every result can be reproduced." />
      <Card>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="ex-g">Game</Label>
              <Select id="ex-g" value={game} onChange={(e) => setGame(e.target.value)}>
                <option value="">All games</option>
                {["crash", "blackjack", "keno", "mines"].map((g) => <option key={g} value={g}>{g}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="ex-s">Final assessment</Label>
              <Select id="ex-s" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All</option>
                <option value="match_commitment_unproven">Result matches, commitment timing unproven</option>
                <option value="verified_sufficient_evidence">Verified with sufficient evidence</option>
                <option value="reconstructed_only">Reconstructed only</option>
                <option value="mismatch">Result mismatch</option>
                <option value="commitment_mismatch">Commitment mismatch</option>
                <option value="incomplete">Incomplete evidence</option>
              </Select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              ["csv", "CSV", "One row per round; streamed, any size. Formula-like cells are neutralised."],
              ["json", "JSON", "Exact inputs, outcomes, comparisons and statuses (traces up to 2,000 rounds)."],
              ["html", "HTML", "Readable evidence report (up to 1,000 rounds)."],
              ["pdf", "PDF", "Printable evidence report (up to 1,000 rounds)."],
            ].map(([f, label, desc]) => (
              <a key={f} href={api.exportUrl(f, params)} className="rounded-xl border border-line bg-panel-2 p-4 transition-colors hover:border-accent/60" data-testid={`export-${f}`}>
                <div className="text-lg font-semibold">{label}</div>
                <div className="text-xs text-muted">{desc}</div>
              </a>
            ))}
          </div>
          <p className="text-xs text-muted">For a single round, “Standalone script” in Round History produces a self-contained Node.js file that recomputes the outcome without this app.</p>
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------------- Settings ---------------- */
export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof api.meta>> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api.settings().then(setS).catch((e) => setMsg(e.message));
    api.meta().then(setMeta).catch(() => {});
  }, []);
  if (!s) return msg ? <p className="text-bad">{msg}</p> : null;
  const save = async () => {
    try {
      setS(await api.saveSettings(s));
      setMsg("Saved. New verifications use these settings. Existing records keep the assessment they were audited with until you re-audit them.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const reauditAll = async () => {
    if (!confirm("Re-audit every stored record with the current settings? Previous audits are kept in each record's history.")) return;
    const r = await api.reverifyMany({});
    setMsg(`Re-audited ${r.rounds} records: ${r.reproduced} reproduced exactly, ${r.statusChanged} changed assessment.`);
  };
  const backup = async () => {
    try {
      const b = await api.backup();
      setMsg(`Backup written: ${b.file} (${(b.bytes / 1e6).toFixed(1)} MB). To restore, stop the app and replace data\\fairness-lab.db with this file.`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div>
      <PageHeader icon={<SettingsIcon className="h-5 w-5" />} title="Settings" />
      <div className="max-w-3xl space-y-6">
        <Card>
          <CardContent className="space-y-6">
            <div>
              <Label htmlFor="scheme">Commitment scheme</Label>
              <Select id="scheme" value={s.commitmentScheme} onChange={(e) => setS({ ...s, commitmentScheme: e.target.value as Settings["commitmentScheme"] })} data-testid="commitment-scheme">
                <option value="unconfirmed">Unconfirmed (default) — compare against SHA-256 candidate, never report as verified</option>
                <option value="sha256_utf8_hex">SHA-256(UTF-8 server seed), hex — I have confirmed this is Solpump's scheme</option>
              </Select>
              <p className="mt-2 text-xs text-muted">
                The Lab could not independently confirm Solpump's commitment construction. Only switch this on once you have confirmed it from Solpump's published documentation for the relevant game. Even then, a hash you type in does not prove it existed before the round.
              </p>
            </div>
            <div>
              <Label htmlFor="rpc">Solana RPC URL (read-only, optional)</Label>
              <Input id="rpc" value={s.solanaRpcUrl} onChange={(e) => setS({ ...s, solanaRpcUrl: e.target.value })} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={save}>Save settings</Button>
              <Button variant="secondary" onClick={reauditAll}>Re-audit all records</Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Data</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {meta && (
              <p className="text-muted">
                Lab {meta.version} · database schema v{meta.schemaVersion}
                {meta.migration && ` · upgraded from v${meta.migration.from} at startup${meta.migration.backup ? ` (backup: ${meta.migration.backup})` : ""}`}
              </p>
            )}
            <Button variant="secondary" onClick={backup}><DatabaseBackup className="h-4 w-4" aria-hidden /> Create database backup</Button>
            <p className="text-xs text-muted">Records are never deleted automatically. Backups are consistent snapshots written to data\backups.</p>
          </CardContent>
        </Card>
        {msg && <p className="text-sm text-muted" role="status">{msg}</p>}
      </div>
    </div>
  );
}
