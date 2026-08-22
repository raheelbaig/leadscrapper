import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // -------------------------------------------------------------------------
  // Architectural boundaries. These are build failures, not conventions.
  // -------------------------------------------------------------------------
  {
    // The browser must never reach server code. This is what keeps the Google
    // API key and the Supabase service-role key out of the client bundle.
    files: ["src/components/**/*.{ts,tsx}", "src/hooks/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/*", "@/server/**"],
              message:
                "Client-side code must not import from src/server/. Fetch through an API route instead - server modules hold the Google and service-role keys.",
            },
          ],
        },
      ],
    },
  },
  {
    // The Places search engine may not depend on enrichment. This is what
    // guarantees the search loop makes no request to any host but Google's.
    //
    // Stated as "all of src/server EXCEPT two directories" rather than as a
    // list of the directories it applies to, so a new server module is fenced
    // in by default instead of being exempt until someone remembers to add it.
    //
    // THE TWO EXEMPTIONS, and nothing else:
    //
    //   src/server/enrichment/**  -- is the subsystem.
    //   src/server/generate/**    -- is the orchestration layer, and the single
    //                                place allowed to see both a search phase
    //                                and an email phase. That is the whole
    //                                reason the directory exists.
    //
    // The second pattern is what keeps that exemption narrow: everything under
    // src/server is forbidden from importing the orchestrator, so the boundary
    // above cannot be reached indirectly by having a search module call into
    // `generate`. Coordination flows one way. Route handlers under
    // src/app/api/generate/** are the intended callers and are outside
    // src/server, so they are unaffected.
    //   src/server/safety-envelope.test.ts -- is the suite that ASSERTS these
    //                                boundaries. It reads the enrichment
    //                                module's own caps in order to pin them, so
    //                                fencing it out would mean the envelope
    //                                could only be checked by a file forbidden
    //                                from checking it.
    files: ["src/server/**/*.ts"],
    ignores: [
      "src/server/enrichment/**/*.ts",
      "src/server/generate/**/*.ts",
      "src/server/safety-envelope.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/enrichment/*", "@/server/enrichment/**", "**/enrichment/**"],
              message:
                "The Places/grid/coverage/export path must not import enrichment. Email discovery is a separate subsystem and must never run inside the search loop. The ONE exception is src/server/generate, the guided flow's orchestration layer.",
            },
            {
              group: ["@/server/generate/*", "@/server/generate/**", "**/server/generate/**"],
              message:
                "src/server/generate is the orchestration layer and may only be imported by route handlers. A server module that reaches back into it creates a cycle across the search/enrichment boundary.",
            },
          ],
        },
      ],
    },
  },

  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "supabase/**"]),
]);

export default eslintConfig;
