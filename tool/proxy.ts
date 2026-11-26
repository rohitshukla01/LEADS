import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isAllowedEmail, NO_SIGN_IN } from "@/lib/auth-config";
import { isPublicPath } from "@/lib/public-paths";

// Auth gate (Next 16 names the middleware file proxy.ts). It runs before every page and
// API route, refreshes the Supabase session, and, outside the public paths
// (lib/public-paths.ts), sends anyone without an allowed signed-in email to /login, or
// answers 401 on API routes.

export async function proxy(request: NextRequest) {
  // Without sign-in (NO_SIGN_IN): the sign-in pages lead to the tool. Only this computer's own
  // addresses are served, and questions are accepted only from the LEADS page itself, so that other
  // websites open in the same browser cannot send questions and use the model key.
  if (NO_SIGN_IN) {
    const { pathname } = request.nextUrl;
    const host = request.headers.get("host") ?? "";
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) {
      return new NextResponse("Open LEADS at http://localhost:3000", { status: 403 });
    }
    if (pathname.startsWith("/api/") && request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.get("origin");
      const isJson = /^application\/json\b/i.test(request.headers.get("content-type") ?? "");
      if (!isJson || (origin !== null && origin !== `http://${host}`)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }
    if (pathname === "/login" || pathname === "/welcome") {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Supabase requires that no code runs between createServerClient and getUser:
  // this call refreshes the auth token / session cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Access requires a signed-in user whose email is on the allowlist (@vt.edu).
  const allowed = !!user && isAllowedEmail(user.email);
  if (!allowed && !isPublicPath(pathname)) {
    if (pathname.startsWith("/api/")) {
      // API routes: a 401 instead of a redirect.
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Pages: redirect to the login screen.
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirectedFrom", pathname);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Run on every route except static assets. /api is included on purpose so the
  // gate covers API routes; public ones are allow-listed in isPublicPath().
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)",
  ],
};
