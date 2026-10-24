/**
 * Hosted (Vercel) behaviour: single-user login, fail-closed without a password, the deployment's own
 * host names, and caches that stay correct when several server instances share one database.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./cleanup.js";
import { buildApp, hostedHosts } from "../../src/api/app.js";
import { FairnessDb } from "../../src/database/db.js";
import { issueSession, validSession, type AuthConfig } from "../../src/api/auth.js";

const tmp = mkdtempSync(join(tmpdir(), "sfl-hosted-"));
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterAll(async () => {
  for (const a of apps) {
    await a.app.close();
    a.db.close();
  }
  removeTempDir(tmp);
});

const HOST = "fairness-lab-test.vercel.app";
const hosted = (password: string | null): AuthConfig => ({ password, secret: "test-secret-0123456789", hosted: true });
async function app(auth: AuthConfig, db?: FairnessDb) {
  const ctx = await buildApp({ db: db ?? (await FairnessDb.open(":memory:")), auth, allowedHosts: [HOST] });
  apps.push(ctx);
  return ctx;
}
const H = { host: HOST };

describe("hosted login", () => {
  it("a hosted deployment without a password refuses every data request", async () => {
    const { app: a } = await app(hosted(null));
    const res = await a.inject({ url: "/api/rounds", headers: H });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/SFL_PASSWORD/);
    expect((await a.inject({ url: "/api/health", headers: H })).statusCode).toBe(200);
    expect((await a.inject({ url: "/api/auth/status", headers: H })).json()).toEqual({ required: true, configured: false, authenticated: false });
  });

  it("data routes need a session; the right password issues a secure HttpOnly SameSite cookie", async () => {
    const { app: a } = await app(hosted("correct horse battery staple"));
    expect((await a.inject({ url: "/api/rounds", headers: H })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url: "/api/verify", headers: H, payload: { input: {} } })).statusCode).toBe(401);

    const bad = await a.inject({ method: "POST", url: "/api/auth/login", headers: H, payload: { password: "wrong" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers["set-cookie"]).toBeUndefined();

    const ok = await a.inject({ method: "POST", url: "/api/auth/login", headers: H, payload: { password: "correct horse battery staple" } });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers["set-cookie"]);
    expect(cookie).toMatch(/^sfl_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
    const session = cookie.split(";")[0];
    expect((await a.inject({ url: "/api/rounds", headers: { ...H, cookie: session } })).statusCode).toBe(200);
    expect((await a.inject({ url: "/api/auth/status", headers: { ...H, cookie: session } })).json().authenticated).toBe(true);

    const out = await a.inject({ method: "POST", url: "/api/auth/logout", headers: H });
    expect(String(out.headers["set-cookie"])).toMatch(/^sfl_session=; .*Max-Age=0/);
  });

  it("forged, expired or foreign-key sessions are refused", async () => {
    const cfg = hosted("pw");
    const { app: a } = await app(cfg);
    const token = issueSession(cfg);
    const [exp, sig] = token.split(".");
    const tries = [`${Number(exp) + 1}.${sig}`, `${exp}.x${sig.slice(1)}`, issueSession({ ...cfg, secret: "other" }), issueSession(cfg, Date.now() - 13 * 3600 * 1000), "garbage"];
    for (const t of tries) expect((await a.inject({ url: "/api/rounds", headers: { ...H, cookie: `sfl_session=${t}` } })).statusCode).toBe(401);
    expect(validSession(cfg, token)).toBe(true);
  });

  it("repeated wrong passwords are throttled", async () => {
    const { app: a } = await app(hosted("pw"));
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await a.inject({ method: "POST", url: "/api/auth/login", headers: H, payload: { password: `guess${i}` } })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  }, 30000);

  it("cross-site requests are still refused, even with a valid session", async () => {
    const cfg = hosted("pw");
    const { app: a } = await app(cfg);
    const res = await a.inject({ method: "POST", url: "/api/verify", headers: { ...H, origin: "https://evil.example", cookie: `sfl_session=${issueSession(cfg)}` }, payload: { input: {} } });
    expect(res.statusCode).toBe(403);
  });

  it("only the deployment's own host names are answered", async () => {
    const { app: a } = await app(hosted("pw"));
    expect((await a.inject({ url: "/api/health", headers: { host: "attacker.example" } })).statusCode).toBe(421);
    expect(hostedHosts({ VERCEL_URL: "abc-123.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "lab.vercel.app", SFL_ALLOWED_HOSTS: "Lab.Example.com, " })).toEqual([
      "abc-123.vercel.app",
      "lab.vercel.app",
      "lab.example.com",
    ]);
  });

  it("local mode without a password needs no login (start.bat behaviour is unchanged)", async () => {
    const { app: a } = await app({ password: null, secret: "s", hosted: false });
    expect((await a.inject({ url: "/api/rounds" })).statusCode).toBe(200);
    expect((await a.inject({ url: "/api/auth/status" })).json()).toEqual({ required: false, configured: false, authenticated: true });
  });
});

describe("several server instances on one database", () => {
  it("cached stats and integrity results never go stale when another instance writes", async () => {
    const file = join(tmp, "shared.db");
    const local = { password: null, secret: "s", hosted: false };
    const a = await app(local, await FairnessDb.open(file));
    const b = await app(local, await FairnessDb.open(file));
    const total = async () => (await a.app.inject({ url: "/api/stats" })).json().metrics.totalRounds;
    expect(await total()).toBe(0);
    await b.app.inject({ method: "POST", url: "/api/verify", payload: { save: true, input: { game: "crash", serverSeed: "s", clientSeed: "c" } } });
    expect(await total()).toBe(1);
    const { rounds } = (await b.app.inject({ url: "/api/rounds" })).json();
    await b.app.inject({ method: "DELETE", url: `/api/rounds/${rounds[0].id}` });
    expect(await total()).toBe(0);
  });

  it("the backup endpoint explains that hosted databases are backed up by the provider", async () => {
    const { app: a, db } = await app({ password: null, secret: "s", hosted: false });
    Object.defineProperty(db, "local", { value: false });
    const res = await a.inject({ method: "POST", url: "/api/backup" });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toMatch(/Turso/);
  });
});
