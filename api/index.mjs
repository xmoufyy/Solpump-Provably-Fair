// Vercel serverless function: every /api/* request is rewritten here (vercel.json).
// The Lab's API is bundled from TypeScript into backend/dist by `npm run build:api` during the build.
export { default } from "../backend/dist/vercel.mjs";
