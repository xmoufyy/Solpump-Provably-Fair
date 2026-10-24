import { lazy, Suspense, useEffect, useState } from "react";
import {
  Binary, Bomb, Download, Fingerprint, GitCompare, Grid3x3, History, KeyRound, Layers, LayoutDashboard, Link2, LogOut, Rocket, Settings, ShieldCheck, Spade,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, AUTH_REQUIRED_EVENT, checkHealth, SERVER_DOWN_MESSAGE } from "@/services/api";
import { LoginScreen } from "@/components/LoginScreen";

// Route-level code splitting: charts (Recharts) and rarely used tools are only downloaded when opened.
const DashboardPage = lazy(() => import("@/pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const CrashPage = lazy(() => import("@/pages/CrashPage").then((m) => ({ default: m.CrashPage })));
const BlackjackPage = lazy(() => import("@/pages/BlackjackPage").then((m) => ({ default: m.BlackjackPage })));
const KenoPage = lazy(() => import("@/pages/KenoPage").then((m) => ({ default: m.KenoPage })));
const MinesPage = lazy(() => import("@/pages/MinesPage").then((m) => ({ default: m.MinesPage })));
const HistoryPage = lazy(() => import("@/pages/HistoryPage").then((m) => ({ default: m.HistoryPage })));
const BatchPage = lazy(() => import("@/pages/BatchPage").then((m) => ({ default: m.BatchPage })));
const SessionsPage = lazy(() => import("@/pages/SessionsPage").then((m) => ({ default: m.SessionsPage })));
const IntegrityPage = lazy(() => import("@/pages/IntegrityPage").then((m) => ({ default: m.IntegrityPage })));
const OnChainPage = lazy(() => import("@/pages/OnChainPage").then((m) => ({ default: m.OnChainPage })));
const HmacInspectorPage = lazy(() => import("@/pages/ToolsPages").then((m) => ({ default: m.HmacInspectorPage })));
const AlgorithmComparisonPage = lazy(() => import("@/pages/ToolsPages").then((m) => ({ default: m.AlgorithmComparisonPage })));
const ExportPage = lazy(() => import("@/pages/ToolsPages").then((m) => ({ default: m.ExportPage })));
const SettingsPage = lazy(() => import("@/pages/ToolsPages").then((m) => ({ default: m.SettingsPage })));

const NAV: { group: string; items: { id: string; label: string; icon: React.ComponentType<{ className?: string }> }[] }[] = [
  { group: "Overview", items: [{ id: "dashboard", label: "Dashboard", icon: LayoutDashboard }] },
  {
    group: "Verify",
    items: [
      { id: "crash", label: "Crash", icon: Rocket },
      { id: "blackjack", label: "Blackjack", icon: Spade },
      { id: "keno", label: "Keno", icon: Grid3x3 },
      { id: "mines", label: "Mines", icon: Bomb },
    ],
  },
  {
    group: "Audit",
    items: [
      { id: "history", label: "Round History", icon: History },
      { id: "batch", label: "Batch Verification", icon: Layers },
      { id: "sessions", label: "Seed Sessions", icon: KeyRound },
      { id: "integrity", label: "Seed Integrity", icon: Fingerprint },
      { id: "onchain", label: "On-Chain Evidence", icon: Link2 },
    ],
  },
  {
    group: "Tools",
    items: [
      { id: "hmac", label: "HMAC Inspector", icon: Binary },
      { id: "compare", label: "Algorithm Comparison", icon: GitCompare },
      { id: "export", label: "Export Reports", icon: Download },
      { id: "settings", label: "Settings", icon: Settings },
    ],
  },
];
const TITLES = Object.fromEntries(NAV.flatMap((g) => g.items).map((i) => [i.id, i.label]));

/** "#/history/12?batch=x" -> { route: "history", arg: "12", params } */
function readHash() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const [route, arg] = path.split("/");
  return { route: route || "dashboard", arg, params: new URLSearchParams(query) };
}

export default function App() {
  const [{ route, arg, params }, setLoc] = useState(readHash);
  const [serverUp, setServerUp] = useState(true);
  // "required": show the sign-in screen. loginInUse: a password protects this deployment (offer Sign out).
  const [auth, setAuth] = useState<{ state: "checking" | "ok" | "required"; configured: boolean; loginInUse: boolean }>({ state: "checking", configured: true, loginInUse: false });
  const [session, setSession] = useState(0);

  useEffect(() => {
    api
      .authStatus()
      .then((s) => setAuth({ state: s.authenticated ? "ok" : "required", configured: s.configured, loginInUse: s.required }))
      .catch(() => setAuth((a) => ({ ...a, state: "ok" }))); // server unreachable: the banner explains
    const onRequired = () => setAuth((a) => ({ ...a, state: "required", loginInUse: true }));
    window.addEventListener(AUTH_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onRequired);
  }, []);

  useEffect(() => {
    const on = () => setLoc(readHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    document.title = `${TITLES[route] ?? "Dashboard"} · Solpump Fairness Lab`;
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [route]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const ok = await checkHealth();
      if (alive) setServerUp(ok);
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const go = (r: string) => (window.location.hash = `/${r}`);
  const signOut = async () => {
    await api.logout().catch(() => {});
    setAuth((a) => ({ ...a, state: "required" }));
  };

  if (auth.state === "checking") return <p className="p-6 text-sm text-muted">Loading…</p>;
  if (auth.state === "required") {
    return <LoginScreen configured={auth.configured} onSignedIn={() => (setAuth((a) => ({ ...a, state: "ok" })), setSession((n) => n + 1))} />;
  }
  const openRound = (id: number) => go(`history/${id}`);

  let page: React.ReactNode;
  switch (route) {
    case "crash": page = <CrashPage />; break;
    case "blackjack": page = <BlackjackPage />; break;
    case "keno": page = <KenoPage />; break;
    case "mines": page = <MinesPage />; break;
    case "history": page = <HistoryPage key={`${arg}?${params}`} initialId={arg ? Number(arg) : undefined} params={params} />; break;
    case "batch": page = <BatchPage />; break;
    case "sessions": page = <SessionsPage />; break;
    case "integrity": page = <IntegrityPage openRound={openRound} />; break;
    case "onchain": page = <OnChainPage />; break;
    case "hmac": page = <HmacInspectorPage />; break;
    case "compare": page = <AlgorithmComparisonPage />; break;
    case "export": page = <ExportPage />; break;
    case "settings": page = <SettingsPage />; break;
    default: page = <DashboardPage go={go} />;
  }

  return (
    <div className="flex h-full">
      <a href="#main" onClick={(e) => (e.preventDefault(), document.getElementById("main")?.focus())} className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-white">
        Skip to content
      </a>
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-panel lg:flex" aria-label="Main navigation">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="rounded-xl bg-gradient-to-br from-accent to-[#5b21b6] p-2 shadow-[0_0_24px_rgb(139_92_246/0.45)]">
            <ShieldCheck className="h-5 w-5 text-white" aria-hidden />
          </div>
          <div className="leading-tight">
            <div className="text-[13px] font-bold tracking-[0.12em]">SOLPUMP</div>
            <div className="text-[11px] tracking-[0.2em] text-accent-2">FAIRNESS LAB</div>
          </div>
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-6 scrollbar-thin">
          {NAV.map((g) => (
            <div key={g.group} role="group" aria-labelledby={`nav-${g.group}`}>
              <div id={`nav-${g.group}`} className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted">{g.group}</div>
              {g.items.map((it) => (
                <a
                  key={it.id}
                  href={`#/${it.id}`}
                  data-testid={`nav-${it.id}`}
                  aria-current={route === it.id ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                    route === it.id ? "bg-accent/15 text-fg shadow-[inset_2px_0_0_var(--color-accent)]" : "text-muted hover:bg-panel-2 hover:text-fg",
                  )}
                >
                  <it.icon className={cn("h-4 w-4", route === it.id && "text-accent-2")} aria-hidden />
                  {it.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3 text-[11px] text-muted">
          <span>Independent verifier · read-only · no wallet</span>
          {auth.loginInUse && (
            <button onClick={signOut} className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 hover:text-fg" data-testid="sign-out">
              <LogOut className="h-3.5 w-3.5" aria-hidden /> Sign out
            </button>
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <nav className="flex gap-1 overflow-x-auto border-b border-line bg-panel px-3 py-2 scrollbar-thin lg:hidden" aria-label="Main navigation (compact)">
          {NAV.flatMap((g) => g.items).map((it) => (
            <a key={it.id} href={`#/${it.id}`} aria-current={route === it.id ? "page" : undefined} className={cn("whitespace-nowrap rounded-md px-2.5 py-1 text-xs", route === it.id ? "bg-accent text-white" : "text-muted")}>
              {it.label}
            </a>
          ))}
          {auth.loginInUse && (
            <button onClick={signOut} className="whitespace-nowrap rounded-md px-2.5 py-1 text-xs text-muted">
              Sign out
            </button>
          )}
        </nav>
        {!serverUp && (
          <div role="alert" data-testid="server-down" className="border-b border-bad/40 bg-bad/10 px-6 py-2.5 text-sm text-bad">
            {window.location.protocol === "file:" ? "This page was opened as a file. Run start.bat and use http://localhost:8787 instead." : SERVER_DOWN_MESSAGE}
          </div>
        )}
        <main id="main" tabIndex={-1} className="flex-1 overflow-y-auto px-4 py-6 outline-none scrollbar-thin sm:px-8">
          <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
            {/* remounted after signing in again, so pages reload their data */}
            <div key={session}>{page}</div>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
