import path from "node:path";

import { defineConfig } from "vitest/config";

const root = process.cwd();

/**
 * The opt-in database suites all talk to ONE shared Supabase project.
 *
 * Run in parallel they interleave: one file snapshots `leads` and asserts it is
 * unchanged while another is inserting its own fixtures into the same table.
 * That produced a failure that vanished on re-run, which is the worst kind --
 * it teaches you to press the button again instead of reading the result.
 *
 * So when the database suites are enabled, test FILES run one at a time. It
 * costs a few seconds and buys a suite whose green means something. The
 * hermetic run touches no shared state and keeps full parallelism.
 */
const DB_TESTS = process.env.LEAD_SCRAPPER_DB_TESTS === "1";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Supplies dummy server env values and installs a throwing `fetch`, so no
    // test can reach the network or pick up a real key from .env.local.
    setupFiles: ["src/test/setup.ts"],
    // The hermetic run must make zero outbound requests. Any test that reached
    // the network would hang rather than quietly succeed, so the timeout stays
    // short enough to catch that.
    //
    // The database suites are a different shape: one guided-generation test
    // drives a whole run to completion, which is dozens of sequential
    // round trips to a hosted Postgres. Ten seconds fails those on latency
    // rather than on behaviour. They still cannot reach anything but Supabase
    // -- `setup.ts` installs a throwing `fetch`, and the external services are
    // injected as fakes.
    testTimeout: DB_TESTS ? 120_000 : 10_000,
    // Cleanup has the same shape as the tests: a DB suite's `afterAll` deletes
    // its fixtures row-set by row-set, which is another handful of round trips.
    // Vitest times hooks out separately from tests, and a hook that gives up
    // half way leaves fixtures behind in a SHARED project -- so it gets the
    // same allowance.
    hookTimeout: DB_TESTS ? 120_000 : 10_000,
    fileParallelism: !DB_TESTS,
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
