"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert, Eye, EyeOff, Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type LoginValues = z.infer<typeof loginSchema>;

/** Supabase phrases these for developers. Say them the way a person would. */
const ERROR_MESSAGES: Record<string, string> = {
  "Invalid login credentials": "That email and password do not match an account.",
  "Email not confirmed": "This address has not been confirmed yet.",
};

const INPUT_CLASS = "h-10 px-3";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/dashboard";

  const [showPassword, setShowPassword] = useState(false);
  // Kept separate from `isSubmitting`, which flips back to false the moment the
  // request resolves and would flash an idle button during the redirect.
  const [isRedirecting, setIsRedirecting] = useState(false);

  const {
    register,
    handleSubmit,
    clearErrors,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const pending = isSubmitting || isRedirecting;

  async function onSubmit(values: LoginValues) {
    clearErrors("root");

    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.auth.signInWithPassword(values);

    if (error) {
      setError("root", { message: ERROR_MESSAGES[error.message] ?? error.message });
      return;
    }

    setIsRedirecting(true);
    router.replace(next.startsWith("/") ? next : "/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="you@company.com"
          autoComplete="username"
          autoFocus
          disabled={pending}
          className={INPUT_CLASS}
          aria-invalid={!!errors.email}
          aria-describedby={errors.email ? "email-error" : undefined}
          {...register("email")}
        />
        {errors.email ? (
          <p id="email-error" className="text-destructive text-xs">
            {errors.email.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            placeholder="••••••••"
            autoComplete="current-password"
            disabled={pending}
            className={`${INPUT_CLASS} pr-10`}
            aria-invalid={!!errors.password}
            aria-describedby={errors.password ? "password-error" : undefined}
            {...register("password")}
          />
          <div className="absolute inset-y-0 right-1.5 flex items-center">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={pending}
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((visible) => !visible)}
              className="text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
          </div>
        </div>
        {errors.password ? (
          <p id="password-error" className="text-destructive text-xs">
            {errors.password.message}
          </p>
        ) : null}
      </div>

      {errors.root ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Could not sign in</AlertTitle>
          <AlertDescription>{errors.root.message}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" className="h-10 w-full gap-2" disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        {pending ? "Signing in" : "Sign in"}
      </Button>
    </form>
  );
}

export function LoginFormSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-18" />
        <Skeleton className="h-10 w-full" />
      </div>
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
