import { useEffect, useState } from "react";
import { Binary, Download, GitCompare, Plus, Settings as SettingsIcon, Trash2 } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Segmented, Select } from "@/components/ui";
import { PageHeader, StatusBadge } from "@/components/verification";
import { api, type KenoDifficulty, type Settings, type VerificationResult } from "@/services/api";

/* ---------------- HMAC Inspector ---------------- */
type Part = { value: string; encoding: "utf8" | "hex" | "uint32be" };

export function HmacInspectorPage() {
  const [key, setKey] = useState("");
  const [keyEnc, setKeyEnc] = useState<"utf8" | "hex">("utf8");
  const [parts, setParts] = useState<Part[]>([{ value: "", encoding: "utf8" }]);
  const [out, setOut] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tParts, setTParts] = useState("solpump:provably-fair:hmac-sha256:v2\nkeno\nCLIENT\n1");
  const [tHex, setTHex] = useState<string | null>(null);

  const run = async () => {
    setErr(null);
    try {
      setOut(await api.hmac({ key, keyEncoding: keyEnc, parts }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const runTranscript = async () => {
    const r = await api.transcript(tParts.split("\n"));
    setTHex(r.hex);
  };

  return (
    <div>
      <PageHeader icon={<Binary className="h-5 w-5" />} title="HMAC Inspector" subtitle="Compute HMAC-SHA256 over arbitrary byte sequences to check any step of a trace by hand. Message parts are concatenated in order with no separators." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>HMAC-SHA256</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Key</Label>
              <div className="flex gap-2">
                <Input value={key} onChange={(e) => setKey(e.target.value)} data-testid="hmac-key" />
                <Select className="w-28" value={keyEnc} onChange={(e) => setKeyEnc(e.target.value as "utf8" | "hex")}>
                  <option value="utf8">UTF-8</option>
                  <option value="hex">hex</option>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Message parts</Label>
              {parts.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <Input value={p.value} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} data-testid={`hmac-part-${i}`} />
                  <Select className="w-32" value={p.encoding} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, encoding: e.target.value as Part["encoding"] } : x)))}>
                    <option value="utf8">UTF-8</option>
                    <option value="hex">hex</option>
                    <option value="uint32be">uint32 BE</option>
                  </Select>
                  <Button variant="ghost" size="icon" onClick={() => setParts(parts.filter((_, j) => j !== i))} disabled={parts.length === 1} aria-label="Remove part"><Trash2 className="h-4 w-4" /></Button>
                </div>
              ))}
              <Button variant="secondary" size="sm" onClick={() => setParts([...parts, { value: "", encoding: "utf8" }])}><Plus className="h-3.5 w-3.5" /> Add part</Button>
            </div>
            <Button onClick={run} data-testid="hmac-run">Compute</Button>
            {err && <p className="text-sm text-bad">{err}</p>}
            {out && (
              <div className="space-y-2 rounded-lg bg-bg p-3 font-mono text-xs">
                <div><span className="font-sans text-muted">Key bytes: </span><span className="break-all">{out.keyHex}</span></div>
                <div><span className="font-sans text-muted">Message bytes: </span><span className="break-all">{out.messageHex}</span></div>
                <div className="text-sm text-accent-2" data-testid="hmac-output"><span className="font-sans text-xs text-muted">HMAC: </span><span className="break-all">{out.hmac}</span></div>
                <div><span className="font-sans text-muted">SHA-256(key): </span><span className="break-all">{out.sha256OfKey}</span></div>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>V2 transcript encoder</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted">One part per line. Each part is encoded as uint32be(UTF-8 byte length) followed by its UTF-8 bytes. Paste the result into a hex message part, then add a uint32 BE counter part (0, 1, …) to reproduce a block.</p>
            <textarea className="h-32 w-full rounded-lg border border-line bg-bg p-2 font-mono text-sm" value={tParts} onChange={(e) => setTParts(e.target.value)} spellCheck={false} />
            <Button variant="secondary" onClick={runTranscript}>Encode</Button>
            {tHex && <div className="break-all rounded-lg bg-bg p-3 font-mono text-xs">{tHex}</div>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Algorithm comparison ---------------- */
export function AlgorithmComparisonPage() {
  const [game, setGame] = useState<"keno" | "mines">("keno");
  const [serverSeed, setServerSeed] = useState("");
  const [clientSeed, setClientSeed] = useState("");
  const [nonce, setNonce] = useState("");
  const [difficulty, setDifficulty] = useState<KenoDifficulty>("CLASSIC");
  const [grid, setGrid] = useState(5);
  const [mines, setMines] = useState(3);
  const [res, setRes] = useState<VerificationResult[] | null>(null);

  const run = async () => {
    const input = game === "keno" ? { game, serverSeed, clientSeed, nonce, difficulty } : { game, serverSeed, clientSeed, nonce, gridSize: grid, mineCount: mines };
    setRes((await api.compareVersions(input)).results);
  };

  return (
    <div>
      <PageHeader
        icon={<GitCompare className="h-5 w-5" />}
        title="Algorithm Comparison"
        subtitle="Runs HMAC SHA256 V2 and Seedrandom V1 side by side on the same inputs for inspection. This is not verification: which version applies to a round must come from the round's own record, never from which one happens to match."
      />
      <Card className="mb-6">
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div>
            <Label>Game</Label>
            <Segmented value={game} onChange={setGame} options={[{ value: "keno", label: "Keno" }, { value: "mines", label: "Mines" }]} />
          </div>
          <div><Label>Server seed</Label><Input value={serverSeed} onChange={(e) => setServerSeed(e.target.value)} /></div>
          <div><Label>Client seed</Label><Input value={clientSeed} onChange={(e) => setClientSeed(e.target.value)} /></div>
          <div><Label>Nonce</Label><Input value={nonce} onChange={(e) => setNonce(e.target.value)} /></div>
          {game === "keno" ? (
            <div>
              <Label>Difficulty</Label>
              <Select value={difficulty} onChange={(e) => setDifficulty(e.target.value as KenoDifficulty)}>
                {["CLASSIC", "LOW", "MEDIUM", "HIGH", "EXTREME"].map((d) => <option key={d}>{d}</option>)}
              </Select>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Grid</Label>
                <Select value={grid} onChange={(e) => (setGrid(Number(e.target.value)), setMines(Math.min(mines, Number(e.target.value) ** 2 - 1)))}>
                  {[3, 5, 6, 7, 8].map((g) => <option key={g} value={g}>{g}×{g}</option>)}
                </Select>
              </div>
              <div><Label>Mines</Label><Input type="number" min={1} max={grid * grid - 1} value={mines} onChange={(e) => setMines(Number(e.target.value))} /></div>
            </div>
          )}
          <div className="flex items-end"><Button className="w-full" onClick={run}>Compare</Button></div>
        </CardContent>
      </Card>
      {res && (
        <div className="grid gap-6 md:grid-cols-2">
          {res.map((r) => (
            <Card key={r.algorithmVersion}>
              <CardHeader><CardTitle className="font-mono">{r.algorithmVersion}</CardTitle><StatusBadge status={r.outcome.status} /></CardHeader>
              <CardContent className="font-mono text-sm">
                {r.calculated ? (game === "keno" ? (r.calculated.drawn as number[]).join(", ") : `mines: ${(r.calculated.mines as number[]).join(", ")}`) : r.outcome.details.join("; ")}
              </CardContent>
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
      <PageHeader icon={<Download className="h-5 w-5" />} title="Export Reports" subtitle="Reports separate recorded evidence (what was supplied) from calculated results, and include the algorithm version and full trace so every result can be reproduced." />
      <Card>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label>Game</Label>
              <Select value={game} onChange={(e) => setGame(e.target.value)}>
                <option value="">All games</option>
                {["crash", "blackjack", "keno", "mines"].map((g) => <option key={g} value={g}>{g}</option>)}
              </Select>
            </div>
            <div>
              <Label>Overall status</Label>
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All</option>
                <option value="match_commitment_unproven">Result matches, commitment unproven</option>
                <option value="verified_sufficient_evidence">Verified with sufficient evidence</option>
                <option value="reconstructed_only">Reconstructed only</option>
                <option value="mismatch">Mismatch</option>
                <option value="incomplete">Incomplete</option>
              </Select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              ["csv", "CSV", "One row per round, spreadsheet-friendly"],
              ["json", "JSON", "Full inputs, outcomes, statuses and traces"],
              ["html", "HTML", "Self-contained readable report"],
              ["pdf", "PDF", "Printable report"],
            ].map(([f, label, desc]) => (
              <a key={f} href={api.exportUrl(f, params)} className="rounded-xl border border-line bg-panel-2 p-4 transition-colors hover:border-accent/60" data-testid={`export-${f}`}>
                <div className="text-lg font-semibold">{label}</div>
                <div className="text-xs text-muted">{desc}</div>
              </a>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------------- Settings ---------------- */
export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api.settings().then(setS);
  }, []);
  if (!s) return null;
  const save = async () => {
    try {
      setS(await api.saveSettings(s));
      setMsg("Saved. New verifications use these settings; existing records keep the status they were audited with.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div>
      <PageHeader icon={<SettingsIcon className="h-5 w-5" />} title="Settings" />
      <Card className="max-w-3xl">
        <CardContent className="space-y-6">
          <div>
            <Label>Commitment scheme</Label>
            <Select value={s.commitmentScheme} onChange={(e) => setS({ ...s, commitmentScheme: e.target.value as Settings["commitmentScheme"] })} data-testid="commitment-scheme">
              <option value="unconfirmed">Unconfirmed (default) — compare against SHA-256 candidate, never report as verified</option>
              <option value="sha256_utf8_hex">SHA-256(UTF-8 server seed), hex — I have confirmed this is Solpump's scheme</option>
            </Select>
            <p className="mt-2 text-xs text-muted">
              The lab could not independently confirm Solpump's commitment construction when it was built. Only switch this on once you have confirmed it from Solpump's published documentation for the relevant game. Even then, a hash you type in does not prove it existed before the round.
            </p>
          </div>
          <div>
            <Label htmlFor="rpc">Solana RPC URL (read-only, optional)</Label>
            <Input id="rpc" value={s.solanaRpcUrl} onChange={(e) => setS({ ...s, solanaRpcUrl: e.target.value })} />
          </div>
          <Button onClick={save}>Save settings</Button>
          {msg && <p className="text-sm text-muted">{msg}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
