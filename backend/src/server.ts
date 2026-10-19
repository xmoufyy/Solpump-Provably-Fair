import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./api/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "localhost";

const { app } = await buildApp({ staticDir: resolve(here, "../../frontend/dist"), logger: process.env.SFL_LOG === "1" });
await app.listen({ port, host });
console.log(`Solpump Fairness Lab running at http://localhost:${port}`);
