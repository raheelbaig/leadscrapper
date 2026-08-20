"use client";

import { LogOut, Menu, Moon, Radar, ShieldCheck, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { QuotaIndicator } from "@/components/layout/quota-indicator";
import { SidebarNav } from "@/components/layout/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { APP_NAME } from "@/lib/constants";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export function Topbar({ email }: { email?: string | null }) {
  const [open, setOpen] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const router = useRouter();

  async function signOut() {
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.auth.signOut();
    if (error) {
      toast.error("Could not sign out", { description: error.message });
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <header className="bg-background/80 sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b px-4 backdrop-blur-sm lg:px-6">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Open navigation"
            />
          }
        >
          <Menu className="size-4" />
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <SheetHeader className="h-14 flex-row items-center gap-2 border-b px-5">
            <div className="bg-primary/10 text-primary flex size-7 items-center justify-center rounded-md">
              <Radar className="size-4" />
            </div>
            <SheetTitle className="text-sm font-semibold">{APP_NAME}</SheetTitle>
          </SheetHeader>
          <SidebarNav onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      <Link href="/dashboard" className="flex items-center gap-2 lg:hidden">
        <span className="text-sm font-semibold">{APP_NAME}</span>
      </Link>

      <div className="ml-auto flex items-center gap-2">
        <QuotaIndicator />

        <Tooltip>
          <TooltipTrigger
            render={
              <Badge
                variant="outline"
                className="hidden gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 sm:flex dark:text-emerald-400"
              />
            }
          >
            <ShieldCheck className="size-3" />
            FREE ONLY
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            This application never makes a paid Google API request. When the protected free
            allowance runs out, searches pause and keep everything already collected.
          </TooltipContent>
        </Tooltip>

        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          <Sun className="size-4 dark:hidden" />
          <Moon className="hidden size-4 dark:block" />
        </Button>

        {email ? (
          <span className="text-muted-foreground hidden max-w-40 truncate text-xs sm:inline">
            {email}
          </span>
        ) : null}

        <Button variant="ghost" size="icon" aria-label="Sign out" onClick={signOut}>
          <LogOut className="size-4" />
        </Button>
      </div>
    </header>
  );
}
