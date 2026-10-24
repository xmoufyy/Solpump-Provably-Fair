import { useState } from "react";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import { Button, FieldError, Input, Label } from "@/components/ui";
import { api } from "@/services/api";

/** Sign-in for a hosted (password-protected) Fairness Lab. Local installs without SFL_PASSWORD never show it. */
export function LoginScreen({ configured, onSignedIn }: { configured: boolean; onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      setPassword("");
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main" className="flex min-h-full items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-6 shadow-xl">
        <div className="mb-5 flex items-center gap-2.5">
          <div className="rounded-xl bg-gradient-to-br from-accent to-[#5b21b6] p-2" aria-hidden>
            <ShieldCheck className="h-5 w-5 text-white" />
          </div>
          <div className="leading-tight">
            <h1 className="text-[13px] font-bold tracking-[0.12em]">SOLPUMP FAIRNESS LAB</h1>
            <p className="text-xs text-muted">Sign in to continue</p>
          </div>
        </div>
        {configured ? (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                className="font-sans"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? "password-error" : undefined}
                autoFocus
                data-testid="login-password"
              />
              <FieldError id="password-error">{error ?? undefined}</FieldError>
            </div>
            <Button type="submit" className="w-full" disabled={busy || !password} data-testid="login-button">
              <LockKeyhole className="h-4 w-4" aria-hidden /> {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-warn" role="alert" data-testid="login-unconfigured">
            This deployment has no password set, so it refuses all data requests. Set <code className="font-mono">SFL_PASSWORD</code> in the hosting provider's environment variables and redeploy.
          </p>
        )}
      </div>
    </main>
  );
}
