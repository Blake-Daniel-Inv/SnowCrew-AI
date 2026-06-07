import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".venv/**",
    "venv/**",
  ]),
  // PR 33: forbid console.* in server-side code so every log line flows
  // through the pino redact list. Tests still need console for diagnostic
  // output, and `*.py.ts` files are Python source strings — not TypeScript
  // that lints.
  {
    files: ["src/app/api/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    ignores: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "src/lib/workspace/export/*.py.ts",
    ],
    rules: {
      "no-console": "error",
    },
  },
]);

export default eslintConfig;
