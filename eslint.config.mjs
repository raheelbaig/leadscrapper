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
    files: [
      "src/server/places/**/*.ts",
      "src/server/geo/**/*.ts",
      "src/server/grid/**/*.ts",
      "src/server/coverage/**/*.ts",
      "src/server/search/**/*.ts",
      "src/server/export/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/enrichment/*", "@/server/enrichment/**", "**/enrichment/**"],
              message:
                "The Places/grid/coverage/export path must not import enrichment. Email discovery is a separate subsystem and must never run inside the search loop.",
            },
          ],
        },
      ],
    },
  },

  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "supabase/**"]),
]);

export default eslintConfig;
