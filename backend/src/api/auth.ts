import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Single-user login for hosted deployments.
 *
 * Enabled when SFL_PASSWORD is set (required when hosted: a hosted deployment without it refuses every
 * data request, so it can never be exposed by accident). The session is a signed, expiring token in an
 * HttpOnly, SameSite=Strict cookie; nothing is stored server-side, so it works across serverless
 * instances. Changing SFL_PASSWORD or SFL_SESSION_SECRET signs everyone out.
 */
export interface AuthConfig {
  /** null: no login (local use) */
  password: string | null;
  /** HMAC key for session tokens */
  secret: string;
  /** a hosted deployment must have a password; without one the data API is closed */
  hosted: boolean;
}

export const SESSION_COOKIE = "sfl_session";
export const SESSION_SECONDS = 12 * 60 * 60;

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const password = env.SFL_PASSWORD ? env.SFL_PASSWORD : null;
  return {
    password,
    // Without an explicit secret, derive one from the password (a token reveals nothing about it: HMAC).
    secret: env.SFL_SESSION_SECRET || createHash("sha256").update(`sfl-session-key:${password ?? ""}`).digest("hex"),
    hosted: Boolean(env.VERCEL),
  };
}

const sign = (secret: string, expires: number) => createHmac("sha256", secret).update(`sfl-session-v1:${expires}`).digest("base64url");

export function issueSession(cfg: AuthConfig, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${expires}.${sign(cfg.secret, expires)}`;
}

export function validSession(cfg: AuthConfig, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  const expires = Number(exp);
  if (!Number.isSafeInteger(expires) || expires * 1000 < now || !sig) return false;
  const expected = Buffer.from(sign(cfg.secret, expires));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Constant-time password check (both sides hashed first so lengths match). */
export function passwordMatches(cfg: AuthConfig, attempt: string): boolean {
  if (cfg.password === null) return false;
  const a = createHash("sha256").update(attempt, "utf8").digest();
  const b = createHash("sha256").update(cfg.password, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionCookie(value: string, maxAge: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/**
 * Failed-login throttle per client address. In memory, so on serverless it is per instance - it slows
 * guessing down but is not a hard limit; a long random password is the real protection.
 */
export class LoginThrottle {
  private failures = new Map<string, number[]>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}
  blocked(key: string, now = Date.now()): boolean {
    const recent = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.failures.set(key, recent);
    return recent.length >= this.max;
  }
  fail(key: string, now = Date.now()) {
    this.failures.set(key, [...(this.failures.get(key) ?? []), now]);
    if (this.failures.size > 10_000) this.failures.clear();
  }
  succeed(key: string) {
    this.failures.delete(key);
  }
}
