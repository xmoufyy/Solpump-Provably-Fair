import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "../tests/reference-parity/**/*.test.ts"],
          testTimeout: 60000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 120000,
          // integration tests share temp dirs/ports; run files sequentially
          fileParallelism: false,
        },
      },
    ],
  },
});
