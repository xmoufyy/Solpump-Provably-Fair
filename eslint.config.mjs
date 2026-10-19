// Lint configuration (flat config). Type-aware rules are kept to the high-value ones.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", ".tmp/**", "data/**", "frontend/test-results/**", "frontend/playwright-report/**", "**/*.mjs", "**/*.py"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "smart"],
      "no-console": "off",
      // Math.random must never be used for fairness verification
      "no-restricted-properties": ["error", { object: "Math", property: "random", message: "Math.random() is forbidden: verification must be deterministic." }],
    },
  },
  {
    files: ["frontend/src/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // tests and diagnostic tools may use loose JSON shapes
    files: ["**/tests/**/*.ts", "tests/**/*.ts", "backend/bench/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/ban-ts-comment": "off" },
  },
);
