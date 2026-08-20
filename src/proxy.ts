import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { publicEnv } from "@/lib/public-env";

/**
 * Next.js 16 renamed the `middleware` convention to `proxy`. It runs on the
 * Node.js runtime.
 *
 * Two jobs:
 *   1. keep the Supabase session cookie fresh, and
 *   2. bounce unauthenticated navigation to /login.
 *
 * This is a convenience guard, NOT the authorization boundary. Route handlers
 * and server components re-check the session themselves, and Row Level
 * Security is the final backstop.
 */
const PUBLIC_PATHS = ["/login", "/auth"];

/**
 * The worker endpoint authenticates with a shared secret presented by pg_cron,
 * not with a browser session, so it must bypass the session redirect.
 */
const SECRET_AUTH_PATHS = ["/api/jobs"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (SECRET_AUTH_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() revalidates the token with Supabase. Do not switch this to
  // getSession(), which trusts whatever the cookie claims.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!user && !isPublic) {
    // An API route answers a `fetch`, not a navigation. Redirecting it to the
    // login page would hand the caller a 200 full of HTML, which `response.ok`
    // reports as success and `response.json()` then chokes on -- an expired
    // session would surface as a parse error rather than as "signed out".
    // The route handlers re-check the session themselves and return the same
    // 401, so this is a faster path to the identical answer.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals and static files.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
