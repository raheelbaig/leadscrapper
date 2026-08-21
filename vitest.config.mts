import path from "node:path";

import { defineConfig } from "vitest/config";

const root = process.cwd();

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Supplies dummy server env values and installs a throwing `fetch`, so no
    // test can reach the network or pick up a real key from .env.local.
    setupFiles: ["src/test/setup.ts"],
    // Phase 2 must make zero outbound requests. Any test that reaches the
    // network would hang rather than quietly succeed.
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      // `server-only` throws outside a React Server Component graph. Next.js
      // resolves it through the `react-server` export condition to an empty
      // module; Vitest has no such condition, so map it explicitly. This is a
      // test-runner concern only -- the real import boundary is still enforced
      // by Next.js at build time and by the ESLint rules in eslint.config.mjs.
      "server-only": path.resolve(root, "node_modules/server-only/empty.js"),
    },
  },
});
