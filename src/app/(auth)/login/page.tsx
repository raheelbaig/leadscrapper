import { Gauge, Lock, MapPinned, Radar, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginForm, LoginFormSkeleton } from "@/app/(auth)/login/login-form";
import { APP_NAME } from "@/lib/constants";

export const metadata: Metadata = { title: "Sign in" };

const HIGHLIGHTS = [
  {
    icon: MapPinned,
    title: "Coverage-first grid search",
    description:
      "Tiles subdivide until they stop saturating, so dense markets are not truncated at Google's 60-result ceiling.",
  },
  {
    icon: Gauge,
    title: "Cost known before the run",
    description: "Every search is preflighted against the remaining free allowance, SKU by SKU.",
  },
  {
    icon: ShieldCheck,
    title: "Never a paid request",
    description:
      "Searches pause when the free allowance runs out and keep everything already collected.",
  },
];

export default function LoginPage() {
  return (
    <div className="grid min-h-full flex-1 lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden border-r bg-zinc-950 p-12 text-zinc-50 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_10%,rgba(255,255,255,0.16),transparent_55%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[image:radial-gradient(white_1px,transparent_1px)] mask-[radial-gradient(circle_at_25%_20%,black,transparent_70%)] bg-size-[26px_26px] opacity-[0.12]"
        />

        <div className="relative flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-white/10">
            <Radar className="size-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight">{APP_NAME}</span>
        </div>

        <div className="relative max-w-md space-y-10">
          <div className="space-y-4">
            <p className="font-heading text-3xl leading-tight font-semibold tracking-tight text-balance">
              Every local lead in a market. Not just the first sixty.
            </p>
            <p className="text-sm leading-relaxed text-zinc-400">
              A private workspace for coverage-first local lead generation.
            </p>
          </div>

          <ul className="space-y-6">
            {HIGHLIGHTS.map((highlight) => (
              <li key={highlight.title} className="flex gap-3.5">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/10">
                  <highlight.icon className="size-4" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">{highlight.title}</p>
                  <p className="text-sm leading-relaxed text-zinc-400">{highlight.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-zinc-500">
          Private deployment · Single account · Free-tier only
        </p>
      </section>

      <section className="flex items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-sm space-y-8">
          <div className="flex items-center gap-2.5 lg:hidden">
            <div className="bg-primary/10 text-primary flex size-8 items-center justify-center rounded-lg">
              <Radar className="size-4" />
            </div>
            <span className="text-sm font-semibold tracking-tight">{APP_NAME}</span>
          </div>

          <div className="space-y-2">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">Welcome back</h1>
            <p className="text-muted-foreground text-sm">Sign in to continue to your workspace.</p>
          </div>

          <Suspense fallback={<LoginFormSkeleton />}>
            <LoginForm />
          </Suspense>

          <div className="border-t pt-6">
            <p className="text-muted-foreground flex items-start gap-2 text-xs leading-relaxed">
              <Lock className="mt-px size-3.5 shrink-0" />
              This is a private, single-account application. Sign-ups are disabled.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
