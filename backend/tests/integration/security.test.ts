/**
 * Security regression tests (audit findings S-xx). Each was run against v1 first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/api/app.js";
import { FairnessDb } from "../../src/database/db.js";

const dir = mkdtempSync(join(tmpdir(), "sfl-sec-"));
let ctx: Awaited<ReturnType<typeof buildApp>>;
const S = "SERVER_TEST_2026", C = "CLIENT_TEST_2026";

beforeAll(async () => {
  ctx = await buildApp({ db: new FairnessDb(join(dir, "sec.db")) });
});
afterAll(async () => {
  await ctx.app.close();
  ctx.db.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const save = (input: Record<string, unknown>) => ctx.app.inject({ method: "POST", url: "/api/verify", payload: { input, save: true } });

describe("S-01 DNS rebinding: requests with a foreign Host header are refused", () => {
  it("Host: attacker.example -> 421", async () => {
    const r = await ctx.app.inject({ url: "/api/rounds", headers: { host: "attacker.example" } });
    expect(r.statusCode).toBe(421);
  });
  it("localhost, 127.0.0.1 and [::1] are accepted", async () => {
    for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"]) {
      expect((await ctx.app.inject({ url: "/api/health", headers: { host } })).statusCode).toBe(200);
    }
  });
});

describe("S-02 CORS: other local origins cannot read the API", () => {
  it("no Access-Control-Allow-Origin for http://localhost:9999", async () => {
    const r = await ctx.app.inject({ url: "/api/rounds", headers: { origin: "http://localhost:9999" } });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("cross-origin JSON POST from a browser page is refused", async () => {
    const r = await ctx.app.inject({
      method: "POST",
      url: "/api/verify",
      headers: { origin: "http://localhost:9999", "content-type": "application/json" },
      payload: { input: { game: "crash", serverSeed: S, clientSeed: C }, save: true },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe("S-03 CSV export formula injection", () => {
  it("cells starting with = + - @ are neutralised in CSV", async () => {
    await save({ game: "crash", serverSeed: S, clientSeed: C, roundId: '=HYPERLINK("http://x","y")', source: "+cmd" });
    const csv = (await ctx.app.inject({ url: "/api/export?format=csv" })).body;
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csv).toContain(",'+cmd,");
  });
});

describe("S-04 LIKE wildcards in search are literal", () => {
  it("searching for % does not match every record", async () => {
    await save({ game: "crash", serverSeed: "plain-seed", clientSeed: C, roundId: "abc" });
    const r = (await ctx.app.inject({ url: "/api/rounds?q=%25" })).json();
    expect(r.total).toBe(0);
  });
});

describe("S-05 Malformed query parameters return 400, not 500 with internals", () => {
  it("limit=abc", async () => {
    const r = await ctx.app.inject({ url: "/api/rounds?limit=abc" });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toMatch(/ZodError|at .*\.ts/);
  });
  it("non-numeric round id", async () => {
    expect((await ctx.app.inject({ url: "/api/rounds/abc" })).statusCode).toBe(400);
  });
});

describe("S-06 Security headers", () => {
  it("API responses carry nosniff and frame protection", async () => {
    const r = await ctx.app.inject({ url: "/api/health" });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
  });
  it("HTML export is served with a script-free CSP", async () => {
    const r = await ctx.app.inject({ url: "/api/export?format=html" });
    expect(String(r.headers["content-security-policy"])).toContain("default-src 'none'");
  });
});

describe("S-07 Settings: RPC URL must be http(s)", () => {
  it("javascript: URL rejected", async () => {
    const r = await ctx.app.inject({ method: "PUT", url: "/api/settings", payload: { solanaRpcUrl: "javascript:alert(1)" } });
    expect(r.statusCode).toBe(400);
  });
  it("file: URL rejected", async () => {
    const r = await ctx.app.inject({ method: "PUT", url: "/api/settings", payload: { solanaRpcUrl: "file:///etc/passwd" } });
    expect(r.statusCode).toBe(400);
  });
});

describe("S-08 HMAC inspector input bounds", () => {
  it("1,000 message parts are rejected", async () => {
    const parts = Array.from({ length: 1000 }, () => ({ value: "a" }));
    const r = await ctx.app.inject({ method: "POST", url: "/api/tools/hmac", payload: { key: "k", parts } });
    expect(r.statusCode).toBe(400);
  });
});

describe("S-09 Untrusted RPC responses are size-limited", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { pad: "x".repeat(12 * 1024 * 1024) } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("a 12 MB RPC response is refused", async () => {
    await ctx.app.inject({ method: "PUT", url: "/api/settings", payload: { solanaRpcUrl: `http://127.0.0.1:${port}` } });
    const sig = "5".repeat(88);
    const r = await ctx.app.inject({ method: "POST", url: "/api/chain/tx", payload: { signature: sig } });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/too large/i);
  });
});
