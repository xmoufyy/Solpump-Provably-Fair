import { useState } from "react";
import { Spade } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, FieldError, Input, Label, Textarea } from "@/components/ui";
import { PageHeader, SeedFields, StatusPanel, TraceView, VerifyBar, emptySeeds, errorMap, seedPayload, type SeedState } from "@/components/verification";
import { useVerifier } from "@/services/useVerifier";
import { cn } from "@/lib/utils";

const SUIT_SYMBOL: Record<string, string> = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };
const RANKS: Record<string, string> = { "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9", "10": "10", t: "10", j: "J", jack: "J", q: "Q", queen: "Q", k: "K", king: "K", a: "A", ace: "A" };
const SUITS: Record<string, string> = { h: "hearts", heart: "hearts", hearts: "hearts", "♥": "hearts", d: "diamonds", diamond: "diamonds", diamonds: "diamonds", "♦": "diamonds", c: "clubs", club: "clubs", clubs: "clubs", "♣": "clubs", s: "spades", spade: "spades", spades: "spades", "♠": "spades" };

function parseCards(text: string): { cards: { label: string; suit: string }[]; error: string | null } {
  const one = (tok: string) => {
    const m = tok.toLowerCase().replace(/\s+of\s+/, " ").match(/^(10|[2-9tjqka]|jack|queen|king|ace)\s*([♥♦♣♠]|hearts?|diamonds?|clubs?|spades?|[hdcs])$/u);
    return m ? { label: RANKS[m[1]], suit: SUITS[m[2]] } : null;
  };
  const tokens = text.split(/[,;\n|]+/).map((t) => t.trim()).filter(Boolean);
  const cards: { label: string; suit: string }[] = [];
  for (const [i, tok] of tokens.entries()) {
    const c = one(tok);
    if (c) {
      cards.push(c);
      continue;
    }
    const parts = tok.split(/\s+/).map(one);
    if (parts.length > 1 && parts.every(Boolean)) cards.push(...(parts as { label: string; suit: string }[]));
    else return { cards: [], error: `Card #${i + 1} "${tok}" not recognised (use e.g. K♣, Kc, 10h, Ace of spades)` };
  }
  return { cards, error: null };
}

export function BlackjackPage() {
  const [seeds, setSeeds] = useState<SeedState>(emptySeeds);
  const [countText, setCountText] = useState("10");
  const [reportedText, setReportedText] = useState("");
  const v = useVerifier();
  const count = Number(countText);
  const countErr = !/^\d+$/.test(countText) || count < 1 || count > 520 ? "Number of cards must be 1–520" : null;
  const reported = parseCards(reportedText);
  const input = { game: "blackjack", ...seedPayload(seeds, false), cardCount: countErr ? 1 : count, reported: reported.cards.length ? { cards: reported.cards } : null };
  const errors = errorMap(v.result);
  const stale = v.isStale(input);
  const calc = !stale ? v.result?.calculated : null;
  const rep: { label: string; suit: string }[] = (!stale && v.result?.reported?.cards) || [];

  const ok = () => !countErr && !reported.error;

  return (
    <div>
      <PageHeader
        icon={<Spade className="h-5 w-5" />}
        title="Blackjack Verification"
        subtitle="Each card number n (starting at 1) gets its own HMAC-SHA256(serverSeed, clientSeed ‖ n). Rank = h mod 13, suit = h mod 4. There is no shuffled deck, so the same card can appear more than once."
      />
      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <Card>
          <CardContent className="space-y-5">
            <SeedFields value={seeds} onChange={setSeeds} errors={errors} withNonce={false} clientLabel="Public / Client Seed" />
            <div>
              <Label htmlFor="cardCount">Number of Cards</Label>
              <Input id="cardCount" data-testid="card-count" value={countText} onChange={(e) => setCountText(e.target.value)} invalid={!!countErr} />
              <FieldError>{countErr}</FieldError>
            </div>
            <div>
              <Label htmlFor="reportedCards">Reported Cards (optional, in card-number order)</Label>
              <Textarea id="reportedCards" data-testid="reported-cards" rows={3} value={reportedText} onChange={(e) => setReportedText(e.target.value)} placeholder="K♣, 7h, Ace of spades" invalid={!!reported.error} />
              <FieldError>{reported.error}</FieldError>
            </div>
            <p className="text-xs text-muted">Player/dealer assignment is not reconstructed: the published algorithm defines the numbered card sequence only.</p>
            <VerifyBar onRun={() => ok() && v.run(input)} onSave={() => ok() && v.run(input, true)} busy={v.busy} saved={v.saved} error={v.error} />
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card className="grid-bg">
            <CardContent>
              <div className="flex flex-wrap justify-center gap-3" data-testid="cards">
                {calc
                  ? calc.cards.map((c: any, i: number) => {
                      const r = rep[i];
                      const status = r ? (r.label === c.label && r.suit === c.suit ? "ok" : "bad") : undefined;
                      return <PlayingCard key={i} n={c.cardNumber} label={c.label} suit={c.suit} status={status} />;
                    })
                  : Array.from({ length: 5 }, (_, i) => <div key={i} className="h-36 w-24 rounded-xl border-2 border-dashed border-line" />)}
              </div>
            </CardContent>
          </Card>
          {stale && <p className="rounded-lg border border-warn/30 bg-warn/5 px-4 py-2 text-sm text-warn">Inputs changed since the last calculation — run Calculate / Verify again.</p>}
          {calc && (
            <Card>
              <CardHeader>
                <CardTitle>Per-card derivation</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto scrollbar-thin">
                <table className="w-full text-xs">
                  <thead className="text-left text-muted">
                    <tr>
                      <th className="py-2 pr-3">#</th>
                      <th className="pr-3">HMAC-SHA256</th>
                      <th className="pr-3">h (52-bit)</th>
                      <th className="pr-3">h%13</th>
                      <th className="pr-3">h%4</th>
                      <th className="pr-3">Card</th>
                      <th>Reported</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {calc.cards.map((c: any, i: number) => {
                      const r = rep[i];
                      const match = r && r.label === c.label && r.suit === c.suit;
                      return (
                        <tr key={i} className="border-t border-line/60">
                          <td className="py-1.5 pr-3">{c.cardNumber}</td>
                          <td className="max-w-[280px] truncate pr-3" title={c.hash}>{c.hash}</td>
                          <td className="pr-3">{c.h}</td>
                          <td className="pr-3">{c.rankIndex}</td>
                          <td className="pr-3">{c.suitIndex}</td>
                          <td className="pr-3 font-sans">{c.label}{SUIT_SYMBOL[c.suit]} <span className="text-muted">{c.label} of {c.suit}</span></td>
                          <td className={cn("font-sans", r ? (match ? "text-ok" : "text-bad") : "text-muted")}>{r ? `${r.label}${SUIT_SYMBOL[r.suit]} ${match ? "✓" : "✗"}` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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

function PlayingCard({ n, label, suit, status }: { n: number; label: string; suit: string; status?: "ok" | "bad" }) {
  const red = suit === "hearts" || suit === "diamonds";
  return (
    <div className="flex flex-col items-center gap-1" data-testid={`card-${n}`} data-card={`${label}-${suit}`}>
      <div
        className={cn(
          "relative h-36 w-24 rounded-xl bg-gradient-to-b from-white to-[#ece9f2] shadow-[0_6px_18px_rgb(0_0_0/0.45)] ring-1 ring-black/10",
          red ? "text-[#d42c4a]" : "text-[#1a1622]",
          status === "ok" && "ring-4 ring-ok",
          status === "bad" && "ring-4 ring-bad",
        )}
      >
        <div className="absolute left-2 top-1.5 text-center leading-none">
          <div className="text-lg font-bold">{label}</div>
          <div className="text-base">{SUIT_SYMBOL[suit]}</div>
        </div>
        <div className="absolute inset-0 flex items-center justify-center text-5xl">{SUIT_SYMBOL[suit]}</div>
        <div className="absolute bottom-1.5 right-2 rotate-180 text-center leading-none">
          <div className="text-lg font-bold">{label}</div>
          <div className="text-base">{SUIT_SYMBOL[suit]}</div>
        </div>
      </div>
      <span className="text-[11px] text-muted">card {n}</span>
    </div>
  );
}
