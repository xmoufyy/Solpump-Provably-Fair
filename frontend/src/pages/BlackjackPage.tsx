import { useMemo, useState } from "react";
import { Spade } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, FieldError, Input, Label, Textarea } from "@/components/ui";
import { ComparisonTable, PageHeader, SeedFields, StaleNotice, StatusPanel, TraceView, VerifyBar, emptySeeds, errorMap, seedPayload, type SeedState } from "@/components/verification";
import { useVerifier } from "@/services/useVerifier";
import { cn, parseCardList, SUIT_SYMBOL } from "@/lib/utils";

const MAX_CARDS = 520;

export function BlackjackPage() {
  const [seeds, setSeeds] = useState<SeedState>(emptySeeds);
  const [countText, setCountText] = useState("10");
  const [reportedText, setReportedText] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const v = useVerifier<"blackjack">();
  const count = Number(countText);
  const countErr = !/^\d+$/.test(countText) || count < 1 || count > MAX_CARDS ? `Number of cards must be 1–${MAX_CARDS}` : null;
  const reported = useMemo(() => parseCardList(reportedText), [reportedText]);
  const reportedErr = reported.errors[0] ?? null;
  const input = { game: "blackjack", ...seedPayload(seeds, false), cardCount: countErr ? 1 : count, reported: reported.cards.length ? { cards: reported.cards } : null };
  const errors = errorMap(v.result);
  const stale = v.isStale(input);
  const calc = !stale ? v.result?.calculated : null;
  const rep = ((!stale && (v.result?.reported?.cards as { label: string; suit: string }[] | undefined)) || []);
  const ok = () => !countErr && !reportedErr;
  const sel = calc && selected !== null ? calc.cards[selected - 1] : null;

  return (
    <div>
      <PageHeader
        icon={<Spade className="h-5 w-5" />}
        title="Blackjack Verification"
        subtitle="Each card number n (starting at 1) gets its own HMAC-SHA256(serverSeed, clientSeed ‖ n). Rank = h mod 13, suit = h mod 4. There is no shuffled deck, so the same card can appear more than once."
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[360px_1fr]">
        <Card>
          <CardContent className="space-y-5">
            <SeedFields value={seeds} onChange={setSeeds} errors={errors} withNonce={false} clientLabel="Public / Client Seed" />
            <div>
              <Label htmlFor="cardCount">Number of Cards</Label>
              <Input id="cardCount" data-testid="card-count" inputMode="numeric" value={countText} onChange={(e) => setCountText(e.target.value)} invalid={!!countErr} aria-invalid={!!countErr} />
              <FieldError>{countErr}</FieldError>
            </div>
            <div>
              <Label htmlFor="reportedCards">Reported Cards (optional, in card-number order)</Label>
              <Textarea id="reportedCards" data-testid="reported-cards" rows={3} value={reportedText} onChange={(e) => setReportedText(e.target.value)} placeholder="K♣, 7h, Ace of spades — or KC 7H AS" invalid={!!reportedErr} aria-invalid={!!reportedErr} />
              <FieldError>{reportedErr}</FieldError>
            </div>
            <p className="text-xs text-muted">Player/dealer assignment is not reconstructed: the published algorithm defines the numbered card sequence only.</p>
            <VerifyBar onRun={() => ok() && v.run(input)} onSave={() => ok() && v.run(input, true)} busy={v.busy} saved={v.saved} error={v.error} stale={stale} />
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card className="grid-bg">
            <CardContent>
              <div className="flex flex-wrap justify-center gap-3" data-testid="cards">
                {calc
                  ? calc.cards.map((c, i) => {
                      const r = rep[i];
                      const status = r ? (r.label === c.label && r.suit === c.suit ? "ok" : "bad") : undefined;
                      return <PlayingCard key={i} n={c.cardNumber} label={c.label} suit={c.suit} status={status} selected={selected === c.cardNumber} onSelect={() => setSelected(selected === c.cardNumber ? null : c.cardNumber)} />;
                    })
                  : Array.from({ length: 5 }, (_, i) => <div key={i} className="h-36 w-24 rounded-xl border-2 border-dashed border-line" aria-hidden />)}
              </div>
              {calc && <p className="mt-4 text-center text-xs text-muted">Select a card to inspect its derivation.</p>}
            </CardContent>
          </Card>
          {stale && <StaleNotice />}
          {sel && (
            <Card data-testid="card-inspector">
              <CardHeader>
                <CardTitle>Card {sel.cardNumber}: {sel.label} of {sel.suit}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 font-mono text-sm">
                <Step k="1. HMAC message" v={`clientSeed + "${sel.cardNumber}" (no separator)`} />
                <Step k="2. HMAC-SHA256(key = server seed)" v={sel.hash} highlight={13} />
                <Step k="3. h = first 13 hex chars as integer" v={`0x${sel.hash.slice(0, 13)} = ${sel.h}`} />
                <Step k="4. rank = h mod 13" v={`${sel.rankIndex} → ${sel.label}   (2,3,…,10,J,Q,K,A)`} />
                <Step k="5. suit = h mod 4" v={`${sel.suitIndex} → ${sel.suit}   (hearts, diamonds, clubs, spades)`} />
              </CardContent>
            </Card>
          )}
          {calc && (
            <Card>
              <CardHeader>
                <CardTitle>Per-card derivation</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto scrollbar-thin">
                <table className="w-full text-xs">
                  <thead className="text-left text-muted">
                    <tr>
                      {["#", "HMAC-SHA256", "h (52-bit)", "h%13", "h%4", "Card", "Reported"].map((h) => (
                        <th key={h} scope="col" className="py-2 pr-3">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {calc.cards.map((c, i) => {
                      const r = rep[i];
                      const match = r && r.label === c.label && r.suit === c.suit;
                      return (
                        <tr key={i} className={cn("border-t border-line/60", selected === c.cardNumber && "bg-accent/10")}>
                          <td className="py-1.5 pr-3">{c.cardNumber}</td>
                          <td className="max-w-[280px] truncate pr-3" title={c.hash}>{c.hash}</td>
                          <td className="pr-3">{c.h}</td>
                          <td className="pr-3">{c.rankIndex}</td>
                          <td className="pr-3">{c.suitIndex}</td>
                          <td className="pr-3 font-sans">
                            {c.label}
                            {SUIT_SYMBOL[c.suit]} <span className="text-muted">{c.label} of {c.suit}</span>
                          </td>
                          <td className={cn("font-sans", r ? (match ? "text-ok" : "text-bad") : "text-muted")}>{r ? `${r.label}${SUIT_SYMBOL[r.suit]} ${match ? "✓ match" : "✗ mismatch"}` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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

function Step({ k, v, highlight }: { k: string; v: string; highlight?: number }) {
  return (
    <div className="grid gap-1 border-b border-line/50 pb-2 sm:grid-cols-[300px_1fr]">
      <span className="font-sans text-muted">{k}</span>
      <span className="break-all">
        {highlight ? (
          <>
            <mark className="rounded bg-accent/30 text-fg">{v.slice(0, highlight)}</mark>
            {v.slice(highlight)}
          </>
        ) : (
          v
        )}
      </span>
    </div>
  );
}

function PlayingCard({ n, label, suit, status, selected, onSelect }: { n: number; label: string; suit: string; status?: "ok" | "bad"; selected: boolean; onSelect: () => void }) {
  const red = suit === "hearts" || suit === "diamonds";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Card ${n}: ${label} of ${suit}${status === "ok" ? ", matches report" : status === "bad" ? ", differs from report" : ""}`}
      className="flex cursor-pointer flex-col items-center gap-1 rounded-xl"
      data-testid={`card-${n}`}
      data-card={`${label}-${suit}`}
    >
      <div
        className={cn(
          "relative h-36 w-24 rounded-xl bg-gradient-to-b from-white to-[#ece9f2] shadow-[0_6px_18px_rgb(0_0_0/0.45)] ring-1 ring-black/10 transition-transform motion-safe:hover:-translate-y-1",
          red ? "text-[#c81e3c]" : "text-[#1a1622]",
          status === "ok" && "ring-4 ring-ok",
          status === "bad" && "ring-4 ring-bad",
          selected && "outline-2 outline-offset-4 outline-accent-2",
        )}
      >
        <div className="absolute left-2 top-1.5 text-center leading-none" aria-hidden>
          <div className="text-lg font-bold">{label}</div>
          <div className="text-base">{SUIT_SYMBOL[suit]}</div>
        </div>
        <div className="absolute inset-0 flex items-center justify-center text-5xl" aria-hidden>
          {SUIT_SYMBOL[suit]}
        </div>
        <div className="absolute bottom-1.5 right-2 rotate-180 text-center leading-none" aria-hidden>
          <div className="text-lg font-bold">{label}</div>
          <div className="text-base">{SUIT_SYMBOL[suit]}</div>
        </div>
      </div>
      <span className="text-[11px] text-muted">card {n}</span>
    </button>
  );
}
