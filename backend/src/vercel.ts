import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./api/app.js";

/**
 * Vercel serverless entry point. The Fastify app (and its database connection) is built once per
 * function instance and reused by later requests to the same instance. Static files are served by
 * Vercel itself (vercel.json); only /api/* reaches this function.
 */
let instance: Promise<FastifyInstance> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  instance ??= buildApp().then(async ({ app }) => {
    await app.ready();
    return app;
  });
  let app: FastifyInstance;
  try {
    app = await instance;
  } catch (e) {
    instance = null; // retry on the next request (e.g. the database was briefly unreachable)
    console.error("Fairness Lab failed to start:", (e as Error).message);
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "The Fairness Lab could not reach its database. Check TURSO_DATABASE_URL / TURSO_AUTH_TOKEN and the function log." }));
    return;
  }
  app.server.emit("request", req, res);
}
